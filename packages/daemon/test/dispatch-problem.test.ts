import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/boot.ts";
import {
	isolationDispatchProblem,
	loadConfig,
	toBootProjects,
} from "../src/config.ts";
import { agentSandboxRefusal } from "../src/containment/agent-preflight.ts";
import { git } from "../src/git.ts";
import { type Logger, silentLogger } from "../src/log.ts";

/**
 * Wave 2 exit review, M1: the default config (bwrap + worktree) is refused at
 * preflight, correctly, but nothing said so until a task failed to start.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(extra: Record<string, string> = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-dispatch-"));
	dirs.push(root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@test"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.txt"), "x\n");
	for (const [f, c] of Object.entries(extra)) await writeFile(join(root, f), c);
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	return root;
}

function recordingLog(lines: string[]): Logger {
	const log = {
		...silentLogger(),
		warn: (_o: unknown, msg?: string) => {
			if (msg) lines.push(msg);
		},
		child: () => log,
	};
	return log as unknown as Logger;
}

async function booted(project: Record<string, unknown>, lines: string[] = []) {
	const home = await mkdtemp(join(tmpdir(), "mfw-dispatch-home-"));
	dirs.push(home);
	await writeFile(
		join(home, "config.json"),
		JSON.stringify({ projects: [{ name: "p", ...project }] }),
	);
	const orch = await boot({
		projects: toBootProjects(await loadConfig(home)),
		mfwHome: home,
		autostart: false,
		log: recordingLog(lines),
	});
	return {
		orch,
		svc: orch.list()[0] as NonNullable<ReturnType<typeof orch.list>[number]>,
	};
}

describe("isolationDispatchProblem agrees with the preflight", () => {
	test.each([
		[{}, /runWorkspace/],
		[{ agentIsolation: "bwrap" }, /runWorkspace/],
		[{ agentIsolation: "bwrap", runWorkspace: "worktree" }, /runWorkspace/],
		[{ approvalMode: "interactive" }, /runWorkspace/],
		[{ runWorkspace: "clone" }, null],
		[{ agentIsolation: "none", approvalMode: "interactive" }, null],
		[{ runWorkspace: "clone", hasDevShell: true }, /\.envrc/],
	] as const)("%j", (input, want) => {
		const problem = isolationDispatchProblem(input);
		if (want) expect(problem?.detail).toMatch(want);
		else expect(problem).toBeNull();
	});

	test("the fix is the exact config change", () => {
		expect(isolationDispatchProblem({})?.fix).toContain(
			'"runWorkspace": "clone"',
		);
	});

	test("what it reports is what preflight refuses", async () => {
		const refusal = await agentSandboxRefusal({
			approvalMode: "autonomous",
			isolation: "bwrap" as never,
			runWorkspace: "worktree",
			projectRoot: "/nonexistent",
			mfwHome: "/nonexistent",
		});
		expect(refusal?.code).toBe("sandbox_unavailable");
		expect(
			isolationDispatchProblem({ runWorkspace: "worktree" }),
		).not.toBeNull();
	});
});

describe("a project that cannot dispatch says so", () => {
	test("at boot, in the inbox and in Settings, with the fix", async () => {
		const lines: string[] = [];
		const { orch, svc } = await booted({ root: await repo() }, lines);
		try {
			expect(lines.some((l) => l.includes('"runWorkspace": "clone"'))).toBe(
				true,
			);
			const item = (await svc.inbox.list()).find(
				(i) => i.id === "admission:sandbox-workspace",
			);
			expect(item?.fix).toContain('"runWorkspace": "clone"');
			const view = await svc.settings.get();
			expect(view.dispatchProblem?.fix).toContain('"runWorkspace": "clone"');
		} finally {
			await orch.shutdown();
		}
	}, 30_000);

	test("a clone project reports nothing", async () => {
		const { orch, svc } = await booted({
			root: await repo(),
			runWorkspace: "clone",
		});
		try {
			expect(
				(await svc.inbox.list()).some(
					(i) => i.id === "admission:sandbox-workspace",
				),
			).toBe(false);
			expect((await svc.settings.get()).dispatchProblem).toBeNull();
		} finally {
			await orch.shutdown();
		}
	}, 30_000);

	test("a clone project with an .envrc reports that instead", async () => {
		const { orch, svc } = await booted({
			root: await repo({ ".envrc": "use flake\n" }),
			runWorkspace: "clone",
		});
		try {
			const item = (await svc.inbox.list()).find(
				(i) => i.id === "admission:sandbox-workspace",
			);
			expect(item?.detail).toContain(".envrc");
		} finally {
			await orch.shutdown();
		}
	}, 30_000);
});
