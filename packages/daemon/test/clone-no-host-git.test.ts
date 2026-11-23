import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepRunner } from "../src/finalize/step-runner.ts";
import { git, gitOk } from "../src/git.ts";
import { quarantineRef } from "../src/host-git/fetch.ts";
import { LocalExecutionTarget } from "../src/local-execution-target.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";

/**
 * Security review P5b, m8: what a clone's tree says about its own HEAD is
 * agent-controlled, so the host reads the quarantine ref in the primary.
 */

let base: string;
let primary: string;
let workspaces: string;
let baseSha: string;
const RUN = "m8run";

async function commit(message: string): Promise<string> {
	await gitOk(
		[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@localhost",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			message,
		],
		primary,
	);
	return gitOk(["rev-parse", "HEAD"], primary);
}

beforeEach(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-m8-")));
	primary = join(base, "primary");
	workspaces = join(base, "mfw/workspaces");
	mkdirSync(primary);
	await gitOk(["init", "-q", "-b", "main"], primary);
	baseSha = await commit("base");
	configureRunWorkspace(primary, {
		kind: "clone",
		clone: { workspaceRoot: workspaces },
	});
});

afterEach(() => {
	clearRunWorkspace(primary);
	rmSync(base, { recursive: true, force: true });
});

/** A clone whose result was imported, with a tree that lies about its HEAD. */
async function importedClone(): Promise<string> {
	const tip = await commit("the run's work");
	await git(["update-ref", quarantineRef(RUN), tip], primary);
	await git(["reset", "-q", "--hard", baseSha], primary);
	const dir = join(workspaces, RUN);
	const tree = join(dir, "tree");
	mkdirSync(join(tree, ".git/refs/heads"), { recursive: true });
	mkdirSync(join(tree, ".git/objects"), { recursive: true });
	writeFileSync(join(tree, ".git/HEAD"), `${baseSha}\n`);
	writeFileSync(join(tree, ".git/config"), "[core]\n\tbare = false\n");
	writeFileSync(
		join(dir, "mfw-workspace.json"),
		JSON.stringify({
			version: 1,
			runId: RUN,
			primaryRoot: primary,
			baseSha,
			branch: `mfw/${RUN}`,
			createdAt: new Date().toISOString(),
			importedTip: tip,
		}),
	);
	return tree;
}

describe("m8: no host git in a clone tree", () => {
	test("a forged HEAD cannot make a clone with imported work read as clean", async () => {
		const tree = await importedClone();
		const runner = Object.create(StepRunner.prototype) as {
			deps: unknown;
			isDirty(run: unknown): Promise<boolean>;
		};
		runner.deps = { projectRoot: primary };
		expect(
			await runner.isDirty({
				id: RUN,
				worktreePath: tree,
				branch: `mfw/${RUN}`,
				baseSha,
			}),
		).toBe(true);
	});

	test("reusing a clone without a recorded base is refused, not read from it", async () => {
		const tree = await importedClone();
		const target = new LocalExecutionTarget({
			projectRoot: primary,
			integrationBranch: "main",
			host: {} as never,
		});
		await expect(
			target.prepare({
				owner: { runId: RUN },
				integrationBranch: "main",
				reuse: { worktreePath: tree, branch: `mfw/${RUN}`, baseSha: null },
			} as never),
		).rejects.toThrow("no recorded base");
	});
});
