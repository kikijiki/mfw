import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type SealedExec,
	sealShellEntry,
	verifyExecPin,
} from "../containment/exec-pin.ts";
import { headSha } from "../git.ts";
import { type SealedCheckout, sealCheckout } from "../host-git/landing.ts";
import type { Logger } from "../log.ts";
import { runProc } from "../proc.ts";
import { pinnedTool, requireHostTool } from "../sandbox.ts";
import { signalOf } from "../verifier.ts";
import type {
	TriggerActionHandler,
	TriggerActionResult,
	TriggerDispatch,
} from "./actions.ts";
import { eventRefs } from "./placeholders.ts";

/**
 * `action: script`: runs `sh -c run` via `runProc` (budgeted, group-killed,
 * output-capped). Payload fields reach the script only through
 * `MFW_EVENT_JSON`; `def.ts` refuses a `run` string with placeholders
 * (shell injection).
 *
 * Nothing runs without the armed exec pin. The command runs from a sealed
 * checkout of the armed commit, never the primary, and only while the event's
 * commit matches that tree outside the owner's may-change list. Everything is
 * verified before any secret is read (`containment/exec-pin.ts`).
 */

const STDERR_TAIL = 8 * 1024; // matches the delivery record's cap
const SCRIPT_ENV_PASSTHROUGH = [
	"PATH",
	"HOME",
	"LANG",
	"TZ",
	// Lets `systemctl --user` / `systemd-run --user` (e.g. a deploy helper's
	// deferred restart) reach the daemon user's session manager.
	"DBUS_SESSION_BUS_ADDRESS",
	"XDG_RUNTIME_DIR",
] as const;

/** Concurrency pool for script actions, separate from `maxConcurrent` (LLM spend) so neither starves the other. */
export class Semaphore {
	private inFlight = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(private readonly max: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.inFlight >= this.max) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			this.waiters.shift()?.();
		}
	}
}

export interface ScriptSecretsStore {
	getSecret(name: string): Promise<string | undefined>;
}

export interface ScriptActionDeps {
	log: Logger;
	secrets: ScriptSecretsStore;
	semaphore: Semaphore;
	/** Process environment is injectable so the security boundary is testable. */
	environment?: Readonly<Record<string, string | undefined>>;
	/** Builds dependencies in the sealed checkout; returns why it could not. */
	installDeps?: (
		dir: string,
		env: Record<string, string>,
	) => Promise<string | null>;
}

/**
 * Host-built dependencies, from the pinned lockfile only: frozen, and with no
 * package lifecycle scripts, so installing runs nothing from the packages.
 */
async function installFromLockfile(
	dir: string,
	env: Record<string, string>,
): Promise<string | null> {
	if (
		!existsSync(join(dir, "bun.lock")) &&
		!existsSync(join(dir, "bun.lockb"))
	) {
		return null;
	}
	const bun = pinnedTool("bun");
	if (!bun) return "bun is not on a trusted PATH";
	const r = await runProc(
		[bun, "install", "--frozen-lockfile", "--ignore-scripts"],
		{ cwd: dir, env, timeoutMs: 5 * 60_000 },
	);
	return r.exitCode === 0
		? null
		: r.stderr.trim().slice(-300) || "bun install failed";
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function createScriptAction(
	deps: ScriptActionDeps,
): TriggerActionHandler {
	return (dispatch) => deps.semaphore.run(() => runScript(dispatch, deps));
}

async function runScript(
	dispatch: TriggerDispatch,
	deps: ScriptActionDeps,
): Promise<TriggerActionResult> {
	const action = dispatch.def.action;
	if (action.kind !== "script") {
		throw new Error("createScriptAction wired to a non-script action");
	}

	// Requested-but-not-granted refuses to dispatch rather than passing an empty
	// string. Defense in depth: the dispatch service already excludes such triggers.
	for (const name of dispatch.def.secrets) {
		if (!dispatch.grantedSecrets.includes(name)) {
			return {
				ok: false,
				detail: `secret "${name}" is requested but not granted by the arming record, refusing to dispatch`,
			};
		}
	}

	const gate = dispatch.execGate;
	if (!gate) {
		return {
			ok: false,
			detail:
				"refusing to execute: this trigger has no armed exec pin. Fix: review it and arm it again.",
			execRefusal: { code: "not_armed" },
		};
	}

	const payload = (dispatch.event.payload ?? {}) as Record<string, unknown>;
	const { taskId, runId } = eventRefs(dispatch.event);
	if (
		typeof payload.sha === "string" &&
		payload.sha.length > 0 &&
		!FULL_SHA.test(payload.sha)
	) {
		return {
			ok: false,
			detail:
				"refusing to execute: the event's sha is not a full commit id. Fix: emit the full hash.",
		};
	}
	const sha =
		typeof payload.sha === "string" && payload.sha.length > 0
			? payload.sha
			: await headSha(dispatch.projectRoot).catch(() => "");

	const env: Record<string, string> = {};
	const sourceEnv = deps.environment ?? process.env;
	for (const key of SCRIPT_ENV_PASSTHROUGH) {
		const v = sourceEnv[key];
		if (v !== undefined) env[key] = v;
	}
	env.MFW_DELIVERY_ID = dispatch.deliveryId;
	env.MFW_PROJECT = dispatch.projectName;
	env.MFW_TRIGGER_ID = dispatch.def.id;
	env.MFW_EVENT_TYPE = dispatch.event.type;
	env.MFW_EVENT_SEQ = String(dispatch.event.seq);
	env.MFW_EVENT_TS = String(dispatch.event.ts);
	env.MFW_TASK_ID = taskId ?? "";
	env.MFW_RUN_ID = runId ?? "";
	env.MFW_SHA = sha;
	env.MFW_EVENT_JSON = JSON.stringify(payload);

	let checkout: SealedCheckout | null = null;
	let sealed: SealedExec | null = null;
	try {
		// A repository with no commit has nothing to seal or compare.
		const commit = gate.pin.commit;
		if (commit) {
			try {
				checkout = await sealCheckout(
					dispatch.projectRoot,
					commit,
					gate.sealRoot,
					gate.landingRoot,
				);
			} catch (e) {
				return {
					ok: false,
					detail: `refusing to execute: cannot check out the armed commit: ${(e as Error).message}. Fix: check that ${commit.slice(0, 12)} still exists, or arm the trigger again.`,
				};
			}
		}
		const cwd = checkout?.path ?? dispatch.projectRoot;
		const verified = await verifyExecPin(gate.pin, {
			root: cwd,
			gitCwd: dispatch.projectRoot,
			rev: sha || "HEAD",
			pathVar: env.PATH,
			...(checkout ? { sealed: true } : {}),
		});
		if (!verified.ok) {
			return {
				ok: false,
				detail: `refusing to execute: ${verified.reason}. Fix: ${verified.fix}`,
				execRefusal: {
					code: verified.code,
					...(verified.path ? { path: verified.path } : {}),
				},
			};
		}
		if (checkout) {
			// Before secrets are read: installing must never see them.
			const install = deps.installDeps ?? installFromLockfile;
			const failed = await install(checkout.path, { ...env });
			if (failed) {
				return {
					ok: false,
					detail: `refusing to execute: could not build dependencies for the armed commit: ${failed}`,
				};
			}
		}
		for (const name of dispatch.def.secrets) {
			const value = await deps.secrets.getSecret(name);
			if (value === undefined) {
				return {
					ok: false,
					detail: `secret "${name}" is granted but not set in credentials.json`,
				};
			}
			env[name.toUpperCase()] = value;
		}
		sealed = await sealShellEntry(
			action.run,
			verified.entry,
			gate.pin,
			cwd,
			gate.sealRoot,
		);
		// One shell, no wrapper prefix: for a single external command `sh -c` execs
		// it, so exitCode/signalCode describe it directly. For multi-statement
		// `run` (`foo && bar`) sh forks and a crash shows as sh's 128+signal exit.
		// Harmless here: a crash and a non-zero exit both mean "delivery failed".
		const argv = sealed?.argv ?? [requireHostTool("sh"), "-c", action.run];
		const result = await runProc(argv, {
			cwd,
			env: { ...env, ...sealed?.env },
			timeoutMs: action.timeoutMs,
		});
		const ok = result.exitCode === 0 && !result.timedOut;
		const signal = result.signalCode ?? signalOf(result.exitCode);
		return {
			ok,
			exitCode: result.exitCode ?? undefined,
			detail: ok
				? undefined
				: result.timedOut
					? `timed out after ${action.timeoutMs}ms`
					: signal
						? `killed by a signal (${signal}): ${result.stderr.slice(-STDERR_TAIL)}`
						: `exit ${result.exitCode}: ${result.stderr.slice(-STDERR_TAIL)}`,
		};
	} finally {
		await sealed?.dispose();
		// One checkout per delivery: always removed, even if dirty.
		await checkout?.dispose();
	}
}
