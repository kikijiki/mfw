import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import {
	describeVerificationEnvironment,
	verify as verifyInSandbox,
} from "../src/verifier.ts";
import { cloneCheckRunner } from "./support/check-clones.ts";

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-verify-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "README.md"), "# v\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	return root;
}

const dod = (checks: unknown[]) =>
	({ verifier: "deterministic", checks }) as never;

/**
 * These cover the check semantics, through a stand-in for the verifier
 * sandbox. The real sandbox (and its non-interactive, empty environment) is
 * covered by check-sandbox-live.
 */
const verify = (
	...[cwd, checks, base, opts]: Parameters<typeof verifyInSandbox>
) =>
	verifyInSandbox(cwd, checks, base, {
		sandbox: { run: cloneCheckRunner, role: "verifier" },
		...opts,
	});

describe("verifier v2: checks", () => {
	test("run checks pass/fail on the expected exit code, with output tail", async () => {
		const root = await repo();
		const ok = await verify(root, dod([{ run: "true", expect_exit: 0 }]), "x");
		expect(ok.passed).toBe(true);

		const bad = await verify(
			root,
			dod([{ run: "echo boom >&2; exit 2", expect_exit: 0 }]),
			"x",
		);
		expect(bad.passed).toBe(false);
		expect(bad.checks[0]?.detail).toContain("boom");
		expect(bad.checks[0]?.exitCode).toBe(2);
		expect(bad.checks[0]?.failureClass).toBe("agent");
		expect(bad.failureClass).toBe("agent");
		expect(ok.failureClass).toBeNull();
		await rm(root, { recursive: true, force: true });
	});

	test("a hanging check times out and is classified, not left to wedge finalize", async () => {
		const root = await repo();
		const r = await verify(
			root,
			dod([{ run: "sleep 30", expect_exit: 0, timeout: 1 }]),
			"x",
		);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.classification).toBe("timeout");
		expect(r.checks[0]?.failureClass).toBe("timeout");
		expect(r.failureClass).toBe("timeout");
		await rm(root, { recursive: true, force: true });
	}, 20_000);

	/** A check killed by a signal (SIGILL/SIGSEGV/SIGKILL/OOM) says nothing about the code under test and must not read as a failing check. */
	test("a check killed by a signal is classified 'crashed', not a plain failure", async () => {
		const root = await repo();
		const r = await verify(
			root,
			// SIGSEGV every time, so the retry crashes too.
			dod([{ run: "kill -11 $$", expect_exit: 0 }]),
			"x",
		);
		expect(r.passed).toBe(false);
		expect(r.crashed).toBe(true);
		expect(r.checks[0]?.classification).toBe("crashed");
		expect(r.checks[0]?.detail).toContain("signal");
		await rm(root, { recursive: true, force: true });
	}, 20_000);

	/**
	 * Wrapped shape: a `checkPrefix` composes as `<prefix> sh -c <check>`, and a
	 * shell with more than one command cannot exec, so it survives its child and
	 * reports 128+signal instead of dying by signal (`exitCode` is not null).
	 * That must still classify as a crash. The two-command form reproduces it.
	 */
	test("a signal death reported as 128+N by a surviving wrapper is 'crashed'", async () => {
		const root = await repo();
		const r = await verify(
			root,
			dod([{ run: "sh -c 'kill -11 $$'; exit $?", expect_exit: 0 }]),
			"x",
		);
		expect(r.passed).toBe(false);
		expect(r.crashed).toBe(true);
		expect(r.checks[0]?.classification).toBe("crashed");
		expect(r.checks[0]?.detail).toContain("SIGSEGV");
		await rm(root, { recursive: true, force: true });
	}, 20_000);

	/** A check that deliberately asserts a 128+N exit must not be re-read as a crash. */
	test("an expected 128+N exit is a pass, not a crash", async () => {
		const root = await repo();
		const r = await verify(
			root,
			dod([{ run: "exit 139", expect_exit: 139 }]),
			"x",
		);
		expect(r.passed).toBe(true);
		expect(r.crashed).toBe(false);
		await rm(root, { recursive: true, force: true });
	}, 20_000);

	test("a signal death that does not recur on retry is not held against the check", async () => {
		const root = await repo();
		const marker = join(root, "ran-once");
		const r = await verify(
			root,
			dod([
				{
					// First run dies to SIGSEGV and leaves a marker; the retry exits cleanly, so the check passes.
					run: `if [ -f ${marker} ]; then exit 0; else touch ${marker}; kill -11 $$; fi`,
					expect_exit: 0,
				},
			]),
			"x",
		);
		expect(r.passed).toBe(true);
		expect(r.crashed).toBe(false);
		expect(r.checks[0]?.ok).toBe(true);
		await rm(root, { recursive: true, force: true });
	}, 20_000);

	test("files_exist and diff_against_base behave", async () => {
		const root = await repo();
		const missing = await verify(
			root,
			dod([{ files_exist: ["nope.txt"] }]),
			"x",
		);
		expect(missing.checks[0]?.classification).toBe("missing-file");

		const present = await verify(
			root,
			dod([{ files_exist: ["README.md"] }]),
			"x",
		);
		expect(present.passed).toBe(true);

		const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
		// unchanged vs its base → the agent did nothing
		const nochange = await verify(
			root,
			dod([{ diff_against_base: true }]),
			head,
		);
		expect(nochange.checks[0]?.classification).toBe("no-change");

		await writeFile(join(root, "new.txt"), "work\n");
		const changed = await verify(
			root,
			dod([{ diff_against_base: true }]),
			head,
		);
		expect(changed.passed).toBe(true);
		await rm(root, { recursive: true, force: true });
	});
});

describe("verifier v2: hardening", () => {
	test("describes the check environment without exposing values", () => {
		const sandboxed = describeVerificationEnvironment({
			checkPrefix: "nix develop -c",
			sandbox: { run: cloneCheckRunner, role: "verifier" },
		});
		expect(sandboxed).toContain("nix develop -c");
		expect(sandboxed).toContain("no network");
		expect(sandboxed).toContain("no ambient environment");
		expect(describeVerificationEnvironment({})).toContain("refused");
	});

	test("without a verifier sandbox a run check is refused, never run on the host", async () => {
		const root = await repo();
		const marker = join(root, "ran-on-host");
		const r = await verifyInSandbox(
			root,
			dod([{ run: `touch '${marker}'`, expect_exit: 0 }]),
			"x",
		);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.detail).toContain("no_verifier_sandbox");
		expect(await Bun.file(marker).exists()).toBe(false);
		await rm(root, { recursive: true, force: true });
	});

	test("runaway output is capped rather than growing daemon memory", async () => {
		const root = await repo();
		const r = await verify(
			root,
			dod([{ run: "yes long-line | head -c 3000000; exit 1", expect_exit: 0 }]),
			"x",
		);
		expect(r.passed).toBe(false);
		// the detail is a tail, not megabytes
		expect((r.checks[0]?.detail ?? "").length).toBeLessThan(10_000);
		await rm(root, { recursive: true, force: true });
	}, 30_000);
});
