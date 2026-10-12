import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DispatchPreflightError,
	preflightDispatch,
	readMemAvailable,
} from "../src/dispatch-preflight.ts";
import { git } from "../src/git.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-preflight-"));
	roots.push(root);
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.txt"), "a\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	return root;
}

async function refusal(
	promise: Promise<void>,
): Promise<DispatchPreflightError> {
	const error = await promise.then(
		() => null,
		(e) => e,
	);
	expect(error).toBeInstanceOf(DispatchPreflightError);
	return error as DispatchPreflightError;
}

describe("dispatch preflight", () => {
	test("a healthy repo passes", async () => {
		const root = await repo();
		await preflightDispatch(
			{
				projectRoot: root,
				integrationBranch: "main",
				memoryFloorBytes: 1n,
				memAvailableBytes: async () => 1n << 30n,
			},
			"run1",
		);
	});

	test("a missing integration branch is refused with the setting to change", async () => {
		const root = await repo();
		const e = await refusal(
			preflightDispatch({ projectRoot: root, integrationBranch: "trunk" }, "r"),
		);
		expect(e.code).toBe("integration_branch_missing");
		expect(e.fix.kind).toBe("setting");
		expect(e.fix.text).toContain("git branch trunk");
		expect(e.fix.text).toContain("integrationBranch");
	});

	test("a leftover run branch is refused with the command that keeps its commits", async () => {
		const root = await repo();
		await git(["branch", "mfw/r1", "main"], root);
		const e = await refusal(
			preflightDispatch({ projectRoot: root, integrationBranch: "main" }, "r1"),
		);
		expect(e.code).toBe("branch_exists");
		expect(e.fix).toEqual({
			kind: "command",
			text: expect.stringContaining("git branch -m mfw/r1 wip/r1-leftover"),
		});
	});

	test("a leftover worktree path is refused with the removal command", async () => {
		const root = await repo();
		await mkdir(join(root, "worktrees", "r2"), { recursive: true });
		const e = await refusal(
			preflightDispatch({ projectRoot: root, integrationBranch: "main" }, "r2"),
		);
		expect(e.code).toBe("worktree_exists");
		expect(e.fix.text).toContain(
			`git worktree remove --force ${join(root, "worktrees", "r2")}`,
		);
	});

	test("memory below the floor is refused; unknown memory or a zero floor passes", async () => {
		const root = await repo();
		const base = { projectRoot: root, integrationBranch: "main" };
		const e = await refusal(
			preflightDispatch(
				{
					...base,
					memoryFloorBytes: 512n << 20n,
					memAvailableBytes: async () => 100n << 20n,
				},
				"r3",
			),
		);
		expect(e.code).toBe("memory_floor");
		expect(e.message).toContain("100 MiB available");
		expect(e.fix.text).toContain("minFreeMemoryMb");
		await preflightDispatch(
			{
				...base,
				memoryFloorBytes: 512n << 20n,
				memAvailableBytes: async () => null,
			},
			"r3",
		);
		await preflightDispatch(
			{ ...base, memoryFloorBytes: 0n, memAvailableBytes: async () => 1n },
			"r3",
		);
	});

	test("MemAvailable is read where /proc/meminfo exists", async () => {
		const value = await readMemAvailable();
		if (process.platform === "linux") expect(value).toBeGreaterThan(0n);
		else expect(value).toBeNull();
	});
});
