import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentReviewInference } from "../src/agent-review.ts";
import { PROBE_EXIT_CODE } from "../src/containment/minimal-probe.ts";
import { git } from "../src/git.ts";
import { type ProcResult, runProc } from "../src/proc.ts";
import { bwrapAvailable, probeSandbox } from "../src/sandbox.ts";

/** Security review G9: the reviewer runs the same minimal probe a run gets. */

async function runInside(): Promise<{
	argv: string[];
	ok: ProcResult;
	leaky: ProcResult;
}> {
	const root = await mkdtemp(join(tmpdir(), "mfw-g9-"));
	try {
		await git(["init", "-q", "-b", "main"], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await writeFile(join(root, "a.txt"), "x\n");
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "init"], root);
		await git(["branch", "mfw/task/g9"], root);
		let out: { argv: string[]; ok: ProcResult; leaky: ProcResult } | null =
			null;
		const reviewer = new AgentReviewInference({
			subject: { projectRoot: root, branch: "mfw/task/g9", runWorktree: null },
			harness: "claude-cli",
			bin: "true",
			run: async (a) => {
				// the reviewer's checkout exists only during the call: run the command here
				const at = a.indexOf("--chdir");
				out = {
					argv: a,
					ok: await runProc(a, { timeoutMs: 20_000 }),
					leaky: await runProc(
						[
							...a.slice(0, at),
							"--setenv",
							"MFW_CANARY_E0",
							"x",
							...a.slice(at),
						],
						{ timeoutMs: 20_000 },
					),
				};
				return {
					exitCode: 0,
					stdout: "{}",
					stderr: "",
					timedOut: false,
					truncated: false,
					signalCode: null,
				};
			},
		});
		await reviewer
			.complete("review", { model: "m", timeoutMs: 5000 } as never)
			.catch(() => undefined);
		if (!out) throw new Error("the reviewer never ran");
		return out;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("reviewer sandbox probe", () => {
	test("the reviewer command carries the probe and the sentinel, and runs clean", async () => {
		if (!(await bwrapAvailable())) return console.log("skip: no bwrap");
		const probe = await probeSandbox({ mode: "bwrap", hidePaths: [] });
		if (!probe.ok)
			return console.log(`skip: bwrap cannot run here (${probe.detail})`);
		const { argv, ok, leaky } = await runInside();
		expect(argv.join(" ")).toContain("sandbox_probe_failed");
		expect(argv).toContain("MFW_PROBE_SENTINEL");
		expect(ok.stderr).toBe("");
		expect(ok.exitCode).toBe(0);
		// a leaked variable inside the reviewer's sandbox stops it before the agent runs
		expect(leaky.exitCode).toBe(PROBE_EXIT_CODE);
		expect(leaky.stderr).toContain("MFW_CANARY_E0");
	}, 60_000);
});
