import { readdir, readFile, readlink } from "node:fs/promises";
import { sep } from "node:path";

/** A process identity, never a bare PID or a working-directory match. */
export interface LeftoverProcess {
	pid: number;
	command: string;
	cwd: string | null;
	runId: string;
	bootId: string;
	startTimeTicks: string;
}

export type ProcessState =
	| { status: "absent" }
	| { status: "unknown" }
	| { status: "live"; bootId: string; startTimeTicks: string };

export interface ProcSource {
	pids(): Promise<number[]>;
	environ(pid: number): Promise<string | null>;
	cwd(pid: number): Promise<string | null>;
	cmdline(pid: number): Promise<string | null>;
	parent(pid: number): Promise<number | null>;
	inspect(pid: number): Promise<ProcessState>;
}

const readOrNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
	try {
		return await read();
	} catch {
		return null;
	}
};

export const linuxProcSource: ProcSource = {
	async pids() {
		// An unavailable process table is not evidence of absence.
		return (await readdir("/proc")).filter((e) => /^\d+$/.test(e)).map(Number);
	},
	environ: (pid) => readOrNull(() => readFile(`/proc/${pid}/environ`, "utf8")),
	cwd: (pid) => readOrNull(() => readlink(`/proc/${pid}/cwd`)),
	cmdline: (pid) =>
		readOrNull(async () =>
			(await readFile(`/proc/${pid}/cmdline`, "utf8"))
				.split("\0")
				.filter(Boolean)
				.join(" "),
		),
	async parent(pid) {
		const stat = await readOrNull(() => readFile(`/proc/${pid}/stat`, "utf8"));
		const m = stat ? /\)\s+\S+\s+(\d+)/.exec(stat) : null;
		return m ? Number(m[1]) : null;
	},
	async inspect(pid) {
		const bootId = await readOrNull(async () =>
			(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
		);
		if (!bootId) return { status: "unknown" };
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
			if (fields[0] === "Z" || fields[0] === "X") return { status: "absent" };
			const startTimeTicks = fields[19];
			if (!startTimeTicks || !/^\d+$/.test(startTimeTicks))
				return { status: "unknown" };
			return { status: "live", bootId, startTimeTicks };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? { status: "absent" }
				: { status: "unknown" };
		}
	},
};

function sameIdentity(p: LeftoverProcess, state: ProcessState): boolean {
	return (
		state.status === "live" &&
		state.bootId === p.bootId &&
		state.startTimeTicks === p.startTimeTicks
	);
}

/** Cwd is diagnostic information only. Only the inherited run marker owns a process. */
export async function findLeftoverProcesses(
	run: { id: string; worktreePath: string | null },
	source: ProcSource = linuxProcSource,
	self: number = process.pid,
): Promise<LeftoverProcess[]> {
	const protectedPids = new Set<number>();
	for (
		let pid: number | null = self;
		pid !== null && pid > 0 && !protectedPids.has(pid);
	) {
		protectedPids.add(pid);
		pid = await source.parent(pid);
	}
	const marker = `MFW_RUN_ID=${run.id}`;
	const out: LeftoverProcess[] = [];
	for (const pid of await source.pids()) {
		if (protectedPids.has(pid)) continue;
		const before = await source.inspect(pid);
		const env = await source.environ(pid);
		if (!env?.split("\0").includes(marker)) {
			if (env === null && run.worktreePath) {
				const cwd = await source.cwd(pid);
				const root = run.worktreePath.replace(/\/$/, "");
				if (cwd === root || cwd?.startsWith(root + sep))
					throw new Error(
						`Unknown worktree occupant ${pid}: run ownership unreadable`,
					);
			}
			continue;
		}
		if (before.status === "absent") continue;
		if (before.status === "unknown")
			throw new Error(`Cannot establish identity of run process ${pid}`);
		const command = (await source.cmdline(pid)) ?? "(unreadable command)";
		const p: LeftoverProcess = {
			pid,
			command: command.length > 300 ? `${command.slice(0, 300)}…` : command,
			cwd: await source.cwd(pid),
			runId: run.id,
			bootId: before.bootId,
			startTimeTicks: before.startTimeTicks,
		};
		const after = await source.inspect(pid);
		if (after.status === "unknown")
			throw new Error(`Cannot recheck run process ${pid}`);
		if (sameIdentity(p, after)) out.push(p);
	}
	return out;
}

export interface Signaller {
	/** Implementations must signal the supplied identity, never a reused PID. */
	kill(
		process: LeftoverProcess,
		signal: "SIGTERM" | "SIGKILL",
	): Promise<boolean>;
}

/** Pin the kernel process before checking /proc; an exit/reuse cannot redirect the signal. */
const processSignaller: Signaller = {
	async kill(p, signal) {
		let close: (() => void) | undefined;
		try {
			const { dlopen } = await import("bun:ffi");
			const lib = dlopen("libc.so.6", {
				pidfd_open: { args: ["i32", "u32"], returns: "i32" },
				pidfd_send_signal: {
					args: ["i32", "i32", "ptr", "u32"],
					returns: "i32",
				},
				close: { args: ["i32"], returns: "i32" },
			});
			close = () => lib.close();
			const fd = lib.symbols.pidfd_open(p.pid, 0);
			if (fd < 0) return false;
			try {
				if (!sameIdentity(p, await linuxProcSource.inspect(p.pid)))
					return false;
				const env = await linuxProcSource.environ(p.pid);
				if (!env?.split("\0").includes(`MFW_RUN_ID=${p.runId}`)) return false;
				return (
					lib.symbols.pidfd_send_signal(
						fd,
						signal === "SIGTERM" ? 15 : 9,
						null,
						0,
					) === 0
				);
			} finally {
				lib.symbols.close(fd);
			}
		} catch {
			// Unsupported libc/kernel or uncertain identity: preserve the claim.
			return false;
		} finally {
			close?.();
		}
	},
};

export interface CleanupResult {
	stopped: number[];
	killed: number[];
	absent: number[];
	live: number[];
	unknown: number[];
}

/** Signal proven owners, then wait for proven absence, including after escalation. */
export async function stopProcesses(
	processes: readonly LeftoverProcess[],
	opts: { graceMs?: number; signaller?: Signaller; source?: ProcSource } = {},
): Promise<CleanupResult> {
	const signaller = opts.signaller ?? processSignaller;
	const source = opts.source ?? linuxProcSource;
	const graceMs = opts.graceMs ?? 3_000;
	const terminated = new Set<number>();
	const killed = new Set<number>();
	const state = async (
		p: LeftoverProcess,
	): Promise<"absent" | "live" | "unknown"> => {
		const current = await source.inspect(p.pid);
		if (current.status !== "live") return current.status;
		if (!sameIdentity(p, current)) return "absent";
		const env = await source.environ(p.pid);
		return env?.split("\0").includes(`MFW_RUN_ID=${p.runId}`)
			? "live"
			: "unknown";
	};
	for (const p of processes) {
		if ((await state(p)) === "live" && (await signaller.kill(p, "SIGTERM")))
			terminated.add(p.pid);
	}
	const wait = async () => {
		const deadline = Date.now() + graceMs;
		while (
			(await Promise.all(processes.map(state))).includes("live") &&
			Date.now() < deadline
		) {
			await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
		}
	};
	await wait();
	for (const p of processes) {
		if ((await state(p)) === "live" && (await signaller.kill(p, "SIGKILL")))
			killed.add(p.pid);
	}
	await wait();
	const result: CleanupResult = {
		stopped: [],
		killed: [],
		absent: [],
		live: [],
		unknown: [],
	};
	for (const p of processes) {
		const status = await state(p);
		result[status].push(p.pid);
		if (status === "absent") {
			if (terminated.has(p.pid)) result.stopped.push(p.pid);
			if (killed.has(p.pid)) result.killed.push(p.pid);
		}
	}
	return result;
}
