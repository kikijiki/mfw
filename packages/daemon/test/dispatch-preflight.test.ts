import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DispatchPreflightError,
	preflightDispatch,
	preflightRemoteAutonomy,
	readMemAvailable,
} from "../src/dispatch-preflight.ts";
import { git } from "../src/git.ts";
import { workspaceRootOf } from "../src/run-workspace/factory.ts";
import { useCheckClones } from "./support/check-clones.ts";

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

describe("remote autonomy preflight", () => {
	for (const kind of ["ssh", "runpod", "some-future-target"]) {
		test(`an autonomous run on '${kind}' is refused with a fix`, () => {
			let error: unknown;
			try {
				preflightRemoteAutonomy(kind, "autonomous");
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(DispatchPreflightError);
			expect(error).toMatchObject({
				code: "remote_autonomy_unsupported",
				waitingFor: [kind],
				fix: { kind: "setting", text: expect.stringContaining("interactive") },
			});
		});

		test(`an interactive run on '${kind}' may proceed`, () => {
			expect(() => preflightRemoteAutonomy(kind, "interactive")).not.toThrow();
		});
	}

	test("the local target has its own sandbox gate and passes here", () => {
		expect(() => preflightRemoteAutonomy("local", "autonomous")).not.toThrow();
	});
});

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

	test("a leftover run clone is refused with the removal step", async () => {
		const root = await repo();
		const drop = useCheckClones(root);
		try {
			const path = join(workspaceRootOf(root) as string, "r2");
			await mkdir(path, { recursive: true });
			const e = await refusal(
				preflightDispatch(
					{ projectRoot: root, integrationBranch: "main" },
					"r2",
				),
			);
			expect(e.code).toBe("workspace_exists");
			expect(e.fix.text).toContain(`delete that directory`);
			expect(e.fix.text).toContain(path);
		} finally {
			await drop();
		}
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

describe("dispatch preflight: the sandbox gate (G2a)", () => {
	test.each([
		["sandbox_unavailable", "bwrap is not on PATH"],
		["sandbox_probe_failed", "environment variable X leaked"],
	] as const)("%s refuses before anything is checked, with a fix", async (code, detail) => {
		const e = await refusal(
			preflightDispatch(
				{
					// would also fail on the branch check: the sandbox gate comes first
					projectRoot: "/nonexistent",
					integrationBranch: "nope",
					sandbox: async () => ({ code, detail }),
				},
				"r",
			),
		);
		expect(e.code).toBe(code);
		expect(e.waitingFor).toEqual([detail]);
		expect(e.fix.kind).toBe("command");
		expect(e.fix.text.length).toBeGreaterThan(20);
	});

	test("a passing gate falls through to the usual checks", async () => {
		const root = await repo();
		await preflightDispatch(
			{
				projectRoot: root,
				integrationBranch: "main",
				sandbox: async () => null,
			},
			"run1",
		);
	});
});
