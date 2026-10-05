import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import {
	buildRunner,
	describeVerificationEnvironment,
	scrubEnv,
	verify,
} from "../src/verifier.ts";

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
		const description = describeVerificationEnvironment({
			checkPrefix: "nix develop -c",
			envPolicy: { allow: ["PATH", "CI"] },
			env: { TEST_DATABASE_URL: "secret-value" },
		});
		expect(description).toContain("nix develop -c");
		expect(description).toContain("PATH, CI");
		expect(description).toContain("TEST_DATABASE_URL");
		expect(description).not.toContain("secret-value");
	});

	test("checks run with a scrubbed env: no ambient secrets reachable", async () => {
		// DoD commands come verbatim from task files, which agents write.
		const root = await repo();
		process.env.MFW_TEST_SECRET = "super-secret-token";
		try {
			const r = await verify(
				root,
				dod([
					{ run: 'test -z "$MFW_TEST_SECRET"', expect_exit: 0 },
					{ run: 'test -n "$PATH"', expect_exit: 0 }, // still usable
					{ run: 'test "$MFW_VERIFY" = 1', expect_exit: 0 },
				]),
				"x",
			);
			expect(r.passed).toBe(true);
		} finally {
			delete process.env.MFW_TEST_SECRET;
		}
		await rm(root, { recursive: true, force: true });
	});

	test("scrubEnv keeps the allowlist and drops everything else", () => {
		const env = scrubEnv({
			PATH: "/usr/bin",
			HOME: "/home/x",
			ANTHROPIC_API_KEY: "sk-leak",
			AWS_SECRET_ACCESS_KEY: "leak",
			RANDOM_THING: "leak",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/x");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.RANDOM_THING).toBeUndefined();
	});

	/** A project declares variables outside the built-in default (a token, `DOCKER_HOST`, ...). */
	test("envPolicy.allow replaces the default list with the project's own", () => {
		const env = scrubEnv(
			{ PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock" },
			{},
			{ allow: ["DOCKER_HOST"] },
		);
		expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
		// PATH is not in the declared list, so it does not survive: the project owns the list once set.
		expect(env.PATH).toBeUndefined();
	});

	test("envPolicy.inherit passes the whole ambient environment through", () => {
		const env = scrubEnv(
			{ PATH: "/usr/bin", ANYTHING: "goes" },
			{},
			{ inherit: true },
		);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.ANYTHING).toBe("goes");
	});

	test("envPolicy.inherit still cannot reopen the non-interactive overrides", () => {
		const env = scrubEnv({ EDITOR: "vim" }, {}, { inherit: true });
		expect(env.EDITOR).toBe("true");
	});

	/** A check has no TTY and nobody to answer prompts; anything interactive must be told not to ask (e.g. `git rebase --continue` needs an editor). */
	test("checks run non-interactively: no editor, no credential prompt", () => {
		const env = scrubEnv({ PATH: "/usr/bin", EDITOR: "vim" });
		// Set, not passed through: the operator's editor would hang the check.
		expect(env.EDITOR).toBe("true");
		expect(env.GIT_EDITOR).toBe("true");
		expect(env.VISUAL).toBe("true");
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	test("a check that would open an editor completes instead of hanging", async () => {
		const root = await repo();
		// `git commit --amend` with no -m opens the editor; under a scrubbed env
		// that must resolve to the no-op `true` and accept the message as-is.
		const r = await verify(
			root,
			dod([{ run: "git commit --amend --allow-empty", expect_exit: 0 }]),
			"x",
		);
		expect(r.passed).toBe(true);
		await rm(root, { recursive: true, force: true });
	}, 20_000);

	/** `checkPrefix` (e.g. `"direnv exec ."`, `"nix develop -c"`) is the only way into the dev environment; mfw never inspects `.envrc` itself. */
	test("checkPrefix is the only thing that enters an environment, no detection", () => {
		expect(buildRunner({})("echo hi")).toEqual(["sh", "-c", "echo hi"]);
		const argv = buildRunner({ checkPrefix: "direnv exec ." })("echo hi");
		expect(argv[0]).toBe("sh");
		expect(argv[2]).toContain("direnv exec . sh -c");
	});

	test("checkPrefix is quoted, so a check cannot break out of it", () => {
		const runner = buildRunner({ checkPrefix: "env FOO=bar" });
		const argv = runner("echo 'quoted; rm -rf /'");
		expect(argv[0]).toBe("sh");
		// the check text is a single quoted argument to the inner sh
		expect(argv[2]).toContain("env FOO=bar sh -c ");
		expect(argv[2]).toContain("'\\''");
	});

	test("checkPrefix composes WITH a sandbox rather than being replaced by it", () => {
		// Env entrypoint and containment are composed by the operator, e.g. `"direnv exec . bwrap --ro-bind / / --"`.
		const argv = buildRunner({
			checkPrefix: "direnv exec . bwrap --ro-bind / / --",
		})("make test");
		expect(argv).toEqual([
			"sh",
			"-c",
			"direnv exec . bwrap --ro-bind / / -- sh -c 'make test'",
		]);
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
