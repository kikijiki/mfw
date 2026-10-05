import { access } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";
import { runProc } from "./proc.ts";
import type { DefinitionOfDone, DoDCheck } from "./tasks/types.ts";

/**
 * Runs a task's DoD checks and never trusts the agent's transcript.
 *
 * Entering the project's dev environment is the operator's declared
 * `checkPrefix` (`"direnv exec ."`, `"nix develop -c"`, ...), composed with the
 * sandbox prefix; mfw does not detect it (MFW-57). An agent cannot author a
 * prefix in the operator's config, unlike an `.envrc` it could write.
 *
 *  1. Scrubbed environment: DoD commands come verbatim from task files that
 *     planners and importers write, so they inherit only what the project's
 *     `envPolicy` allows.
 *  2. Bounded and quoted: every check has a timeout (default 10 min) and an
 *     output cap, and `checkPrefix` is quoted rather than interpolated raw
 *     into `sh -c`.
 */

/**
 * Every class except `failed` is a fact about the outcome (a missing file, an
 * unchanged tree, a timeout, a signal death). A check that ran and returned
 * the wrong exit code is just `failed`; the command text plays no part in
 * classifying it (MFW-56/MFW-57).
 */
export type FailureClass =
	| "failed"
	| "missing-file"
	| "no-change"
	| "timeout"
	| "crashed";

export interface CheckOutcome {
	check: string;
	ok: boolean;
	classification?: FailureClass;
	detail?: string;
	/** The command's observed exit code. Only run checks have one; null means
	 *  the wrapper itself was killed by a signal. */
	exitCode?: number | null;
}

export interface VerificationResult {
	passed: boolean;
	checks: CheckOutcome[];
	/**
	 * The failure is fully explained by a check process dying to a signal
	 * (SIGILL, SIGSEGV, SIGKILL/OOM, ...), never by a check that ran and did
	 * not pass. It says nothing about the code under test. Always `false` when
	 * `passed` is true.
	 */
	crashed: boolean;
}

/**
 * A project's declared policy for what a DoD check may read from the
 * environment (MFW-57). Without a way to say "this project also needs
 * `GIT_EDITOR`", a rebase wedged only under the daemon and never in a
 * developer's shell.
 */
export interface EnvPolicy {
	/**
	 * Replace `DEFAULT_ENV_ALLOWLIST` entirely (not merged), so a project that
	 * still wants `PATH`/`HOME`/etc. must include them.
	 */
	allow?: string[];
	/** Pass the full ambient environment through, unfiltered. */
	inherit?: boolean;
}

export interface VerifyOptions {
	/** Wrapper command for every check (a sandbox/container entrypoint or a
	 *  dev-environment entrypoint like `direnv exec .` / `nix develop -c`).
	 *  Composes with a sandbox prefix by nesting: pass the full composed
	 *  command, e.g. `"direnv exec . bwrap ..."`. */
	checkPrefix?: string;
	/** Default per-check timeout when the DoD does not set one. */
	defaultTimeoutMs?: number;
	/** Extra variables the checks need, applied on top of `envPolicy`. */
	env?: Record<string, string>;
	/** What the checks may read from the ambient environment. Defaults to
	 *  `DEFAULT_ENV_ALLOWLIST`. */
	envPolicy?: EnvPolicy;
	/** Cancels the currently running check (preemptible background sweeps). */
	signal?: AbortSignal;
}

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;
const MAX_CHECK_OUTPUT = 1 * 1024 * 1024;

/**
 * Default when a project declares no `envPolicy`. API keys, tokens and
 * anything else exported stay out of a DoD command's reach.
 */
export const DEFAULT_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"NIX_PATH",
	"NIX_PROFILES",
	"NIX_SSL_CERT_FILE",
	"SSL_CERT_FILE",
	"CI",
];

export function scrubEnv(
	source: NodeJS.ProcessEnv = process.env,
	extra: Record<string, string> = {},
	policy: EnvPolicy = {},
): Record<string, string> {
	const out: Record<string, string> = {};
	if (policy.inherit) {
		for (const [key, v] of Object.entries(source)) {
			if (typeof v === "string") out[key] = v;
		}
	} else {
		for (const key of policy.allow ?? DEFAULT_ENV_ALLOWLIST) {
			const v = source[key];
			if (typeof v === "string") out[key] = v;
		}
	}
	// Mark the context so a check can behave differently under verification.
	out.MFW_VERIFY = "1";

	// A check has no TTY and nobody to answer a prompt, so these are set rather
	// than inherited (an inherited operator `EDITOR` would hang until timeout).
	//
	// Motivating case: a test ran `git rebase --continue`, which opens an
	// editor. With no `EDITOR` and no TTY the rebase stayed in progress and a
	// later assertion failed. It passed in developer shells and failed in every
	// sweep, reddening main and reopening eleven tasks.
	//
	// `true` is a no-op editor: git accepts the message as-is.
	out.EDITOR = "true";
	out.GIT_EDITOR = "true";
	out.VISUAL = "true";
	// Fail a credential prompt immediately instead of hanging until timeout.
	out.GIT_TERMINAL_PROMPT = "0";

	return { ...out, ...extra };
}

/** Human/model-readable account of the verifier context. Values are omitted:
 * diagnosis needs to know what was available, not receive credentials. */
export function describeVerificationEnvironment(opts: VerifyOptions): string {
	const runner = opts.checkPrefix?.trim()
		? `declared check prefix: ${opts.checkPrefix.trim()}`
		: "direct non-interactive shell (no check prefix)";
	const ambient = opts.envPolicy?.inherit
		? "ambient environment inherited by project policy"
		: `scrubbed environment; allowed ambient names: ${(
				opts.envPolicy?.allow ?? DEFAULT_ENV_ALLOWLIST
			).join(", ")}`;
	const extras = Object.keys(opts.env ?? {});
	return [
		runner,
		ambient,
		...(extras.length > 0
			? [`explicit verifier variables: ${extras.join(", ")}`]
			: []),
		"forced non-interactive variables: MFW_VERIFY, EDITOR, GIT_EDITOR, VISUAL, GIT_TERMINAL_PROMPT",
	].join("; ");
}

function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function describe(check: DoDCheck): string {
	if ("run" in check) return `run: ${check.run}`;
	if ("files_exist" in check)
		return `files_exist: ${check.files_exist.join(", ")}`;
	return `diff_against_base: ${check.diff_against_base}`;
}

function lastLines(s: string, n: number): string {
	const lines = s.trimEnd().split("\n");
	return lines.slice(-n).join("\n");
}

/**
 * Did the check's command die from a signal?
 *
 * `runProc` reports `exitCode === null` only when the process it spawned was
 * signalled, but every check runs as `sh -c <command>` (see `buildRunner`), so
 * when the command inside crashes the shell survives and exits with
 * 128+signal (`sh -c 'sh -c "kill -11 $$"'` exits 139, SIGILL 132). Without
 * this a crashing `bun test` (SIGILL six times in fourteen hours under memory
 * pressure) read as a code regression and tripped `main_red` (MFW-56).
 *
 * `expected` is honoured: a check that deliberately asserts a 128+N exit is
 * not a crash.
 */
function diedFromSignal(
	r: { exitCode: number | null; timedOut: boolean },
	expected: number,
): boolean {
	if (r.timedOut) return false; // a timeout is its own classification
	if (r.exitCode === null) return true; // the wrapper itself was signalled
	if (r.exitCode === expected) return false;
	// 128+N, N in 1..64: the POSIX shell's report of a signalled command.
	return r.exitCode > 128 && r.exitCode <= 128 + 64;
}

/**
 * The signal a 128+N shell exit stands for, for the failure detail. Exported
 * for `triggers/script-action.ts`, which decodes the same POSIX convention.
 */
export function signalOf(exitCode: number | null): string | null {
	if (exitCode === null || exitCode <= 128 || exitCode > 128 + 64) return null;
	const n = exitCode - 128;
	const known: Record<number, string> = {
		4: "SIGILL",
		6: "SIGABRT",
		9: "SIGKILL",
		11: "SIGSEGV",
		15: "SIGTERM",
	};
	return known[n] ?? `signal ${n}`;
}

/**
 * Build the command wrapper for checks. `checkPrefix` is the only thing that
 * enters a dev environment or a sandbox (MFW-57). The check is quoted rather
 * than spliced, so it cannot break out of the prefix.
 */
export function buildRunner(
	opts: VerifyOptions,
): (checkCmd: string) => string[] {
	const prefix = opts.checkPrefix?.trim();
	if (prefix) return (c) => ["sh", "-c", `${prefix} sh -c ${q(c)}`];
	return (c) => ["sh", "-c", c];
}

export async function verify(
	cwd: string,
	dod: DefinitionOfDone,
	baseSha: string,
	opts: VerifyOptions = {},
): Promise<VerificationResult> {
	const checks: CheckOutcome[] = [];
	const runner = buildRunner(opts);
	const env = scrubEnv(process.env, opts.env, opts.envPolicy);

	for (const check of dod.checks) {
		const label = describe(check);

		if ("run" in check) {
			if (opts.signal?.aborted) {
				throw new Error("verification preempted");
			}
			const timeoutMs = check.timeout
				? check.timeout * 1000
				: (opts.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
			const expected = check.expect_exit ?? 0;
			const runOnce = () =>
				runProc(runner(check.run), {
					cwd,
					env,
					timeoutMs,
					maxOutputBytes: MAX_CHECK_OUTPUT,
					signal: opts.signal,
				});

			let r = await runOnce();
			if (opts.signal?.aborted) throw new Error("verification preempted");
			let crashed = diedFromSignal(r, expected);
			// A signal death (SIGILL, SIGSEGV, SIGKILL/OOM, ...) says something
			// about this invocation, not the code (MFW-47). One retry tells them
			// apart: observed crashes all cleared on an immediate rerun.
			if (crashed) {
				r = await runOnce();
				if (opts.signal?.aborted) throw new Error("verification preempted");
				crashed = diedFromSignal(r, expected);
			}

			const ok = !r.timedOut && !crashed && r.exitCode === expected;
			checks.push(
				ok
					? { check: label, ok }
					: {
							check: label,
							ok,
							exitCode: r.exitCode,
							classification: r.timedOut
								? "timeout"
								: crashed
									? "crashed"
									: "failed",
							detail: r.timedOut
								? `timed out after ${timeoutMs}ms`
								: crashed
									? `check process was killed by a signal twice in a row${
											r.signalCode
												? ` (${r.signalCode})`
												: signalOf(r.exitCode)
													? ` (${signalOf(r.exitCode)}, reported by the shell as exit ${r.exitCode})`
													: ""
										}; not a result about the code under test`
									: lastLines(r.stdout + r.stderr, 20),
						},
			);
		} else if ("files_exist" in check) {
			const missing: string[] = [];
			for (const f of check.files_exist) {
				try {
					await access(join(cwd, f));
				} catch {
					missing.push(f);
				}
			}
			const ok = missing.length === 0;
			checks.push(
				ok
					? { check: label, ok }
					: {
							check: label,
							ok,
							classification: "missing-file",
							detail: `missing: ${missing.join(", ")}`,
						},
			);
		} else {
			if (!check.diff_against_base) {
				checks.push({ check: label, ok: true });
				continue;
			}
			const head = await git(["rev-parse", "HEAD"], cwd);
			const dirty = await git(["status", "--porcelain"], cwd);
			const changed =
				(head.exitCode === 0 && head.stdout !== baseSha) ||
				dirty.stdout.length > 0;
			checks.push(
				changed
					? { check: label, ok: true }
					: {
							check: label,
							ok: false,
							classification: "no-change",
							detail: "the branch is identical to its base",
						},
			);
		}
	}

	const failing = checks.filter((c) => !c.ok);
	// Every failing check is a signal death: a verifier-side fact, not a code one.
	const crashed =
		failing.length > 0 && failing.every((c) => c.classification === "crashed");
	return { passed: failing.length === 0, checks, crashed };
}
