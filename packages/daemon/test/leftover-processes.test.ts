import { describe, expect, test } from "bun:test";
import {
	findLeftoverProcesses,
	type LeftoverProcess,
	type ProcSource,
	type Signaller,
	stopProcesses,
} from "../src/leftover-processes.ts";

interface FakeProc {
	env?: string[];
	cwd?: string;
	cmd?: string;
	ppid?: number;
	start?: string;
	unknown?: boolean;
}

function source(procs: Record<number, FakeProc>): ProcSource {
	return {
		pids: async () => Object.keys(procs).map(Number),
		environ: async (pid) => procs[pid]?.env?.join("\0") ?? null,
		cwd: async (pid) => procs[pid]?.cwd ?? null,
		cmdline: async (pid) => procs[pid]?.cmd ?? null,
		parent: async (pid) => procs[pid]?.ppid ?? null,
		inspect: async (pid) =>
			!procs[pid] || procs[pid]?.cmd === ""
				? { status: "absent" }
				: procs[pid]?.unknown
					? { status: "unknown" }
					: {
							status: "live",
							bootId: "boot",
							startTimeTicks: procs[pid]?.start ?? "42",
						},
	};
}

describe("findLeftoverProcesses", () => {
	const run = { id: "RUN1", worktreePath: "/wt/run1" };

	test("requires inherited run ownership and excludes human and other-run worktree occupants", async () => {
		const found = await findLeftoverProcesses(
			run,
			source({
				10: { env: ["MFW_RUN_ID=RUN1"], cwd: "/tmp", cmd: "cargo test" },
				11: { env: [], cwd: "/wt/run1/sub", cmd: "human editor" },
				14: {
					env: ["MFW_RUN_ID=RUN2"],
					cwd: "/wt/run1",
					cmd: "other live run",
				},
				12: { env: ["MFW_RUN_ID=RUN2"], cwd: "/wt/run2", cmd: "other run" },
				13: { env: [], cwd: "/wt/run10", cmd: "prefix sibling" },
			}),
			99,
		);
		expect(found.map((p) => p.pid)).toEqual([10]);
		expect(found[0]?.command).toBe("cargo test");
	});

	test("unreadable ownership in the worktree blocks cleanup without authorizing a signal", async () => {
		await expect(
			findLeftoverProcesses(
				run,
				source({ 10: { cwd: "/wt/run1", cmd: "credential-changed writer" } }),
				99,
			),
		).rejects.toThrow("ownership unreadable");
	});

	test("never returns the daemon or its ancestors", async () => {
		const found = await findLeftoverProcesses(
			run,
			source({
				99: {
					env: ["MFW_RUN_ID=RUN1"],
					cwd: "/wt/run1",
					cmd: "daemon",
					ppid: 50,
				},
				50: {
					env: ["MFW_RUN_ID=RUN1"],
					cwd: "/wt/run1",
					cmd: "parent",
					ppid: 1,
				},
				20: { env: ["MFW_RUN_ID=RUN1"], cwd: "/", cmd: "leftover" },
			}),
			99,
		);
		expect(found.map((p) => p.pid)).toEqual([20]);
	});

	test("skips processes with no command line (zombies, kernel threads)", async () => {
		const found = await findLeftoverProcesses(
			run,
			source({ 30: { env: ["MFW_RUN_ID=RUN1"], cmd: "" } }),
			99,
		);
		expect(found).toEqual([]);
	});

	test("a run with no worktree is matched by run id only", async () => {
		const found = await findLeftoverProcesses(
			{ id: "RUN1", worktreePath: null },
			source({
				40: { env: [], cwd: "/wt/run1", cmd: "x" },
				41: { env: ["MFW_RUN_ID=RUN1"], cmd: "y" },
			}),
			99,
		);
		expect(found.map((p) => p.pid)).toEqual([41]);
	});

	test("finds a real child process by its run id", async () => {
		const id = `LEFTOVER-${process.pid}-${Date.now()}`;
		const child = Bun.spawn(["sleep", "30"], {
			env: { ...process.env, MFW_RUN_ID: id },
		});
		try {
			const found = await findLeftoverProcesses({ id, worktreePath: null });
			expect(found.map((p) => p.pid)).toEqual([child.pid]);
			const result = await stopProcesses(found, { graceMs: 2_000 });
			expect(result.stopped).toEqual([child.pid]);
			await child.exited;
			expect(child.signalCode).toBe("SIGTERM");
		} finally {
			child.kill("SIGKILL");
		}
	});
});

const owned = (pid: number): LeftoverProcess => ({
	pid,
	command: "worker",
	cwd: null,
	runId: "RUN1",
	bootId: "boot",
	startTimeTicks: "42",
});

describe("stopProcesses", () => {
	test("confirms exit after SIGTERM and SIGKILL", async () => {
		const procs: Record<number, FakeProc> = {
			10: { env: ["MFW_RUN_ID=RUN1"], cmd: "polite" },
			20: { env: ["MFW_RUN_ID=RUN1"], cmd: "stubborn" },
		};
		const sent: string[] = [];
		const signaller: Signaller = {
			async kill(p, signal) {
				sent.push(`${p.pid}:${signal}`);
				if (signal === "SIGKILL" || p.pid === 10) delete procs[p.pid];
				return true;
			},
		};
		const result = await stopProcesses([owned(10), owned(20)], {
			graceMs: 5,
			signaller,
			source: source(procs),
		});
		expect(result).toEqual({
			stopped: [10, 20],
			killed: [20],
			absent: [10, 20],
			live: [],
			unknown: [],
		});
		expect(sent).toEqual(["10:SIGTERM", "20:SIGTERM", "20:SIGKILL"]);
	});

	test("never signals a reused PID before TERM or escalation", async () => {
		const procs: Record<number, FakeProc> = {
			10: { env: ["MFW_RUN_ID=RUN1"], cmd: "replacement", start: "43" },
			20: { env: ["MFW_RUN_ID=RUN1"], cmd: "original" },
		};
		const sent: string[] = [];
		const result = await stopProcesses([owned(10), owned(20)], {
			graceMs: 0,
			source: source(procs),
			signaller: {
				async kill(p, signal) {
					sent.push(`${p.pid}:${signal}`);
					procs[p.pid] = {
						env: ["MFW_RUN_ID=RUN2"],
						cmd: "replacement",
						start: "43",
					};
					return true;
				},
			},
		});
		expect(sent).toEqual(["20:SIGTERM"]);
		expect(result.absent).toEqual([10, 20]);
		expect(result.killed).toEqual([]);
	});

	test("failed signals and unknown identity are not reported as stopped", async () => {
		const procs: Record<number, FakeProc> = {
			10: { env: ["MFW_RUN_ID=RUN1"], cmd: "unsignallable" },
			20: { env: ["MFW_RUN_ID=RUN1"], cmd: "unknown", unknown: true },
		};
		const result = await stopProcesses([owned(10), owned(20)], {
			graceMs: 0,
			source: source(procs),
			signaller: { kill: async () => false },
		});
		expect(result).toEqual({
			stopped: [],
			killed: [],
			absent: [],
			live: [10],
			unknown: [20],
		});
	});

	test("a successful SIGKILL syscall is not proof the process stopped", async () => {
		const procs: Record<number, FakeProc> = {
			10: { env: ["MFW_RUN_ID=RUN1"], cmd: "still alive" },
		};
		const result = await stopProcesses([owned(10)], {
			graceMs: 0,
			source: source(procs),
			signaller: { kill: async () => true },
		});
		expect(result.live).toEqual([10]);
		expect(result.stopped).toEqual([]);
		expect(result.killed).toEqual([]);
	});
});
