import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProc, TRUNCATION_MARKER } from "../src/proc.ts";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid: number, budgetMs = 3000): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return !pidAlive(pid);
}

describe("runProc", () => {
	test("default timeout is enforced and returns promptly", async () => {
		const t0 = Date.now();
		const res = await runProc(["sleep", "999"], { timeoutMs: 300 });
		const elapsed = Date.now() - t0;
		expect(res.timedOut).toBe(true);
		expect(res.exitCode).not.toBe(0); // killed, never a clean exit
		expect(elapsed).toBeLessThan(4000); // SIGTERM kills sleep at once, no 999 s wait
	});

	test("there is no 'no timeout': 0 and Infinity are rejected", async () => {
		await expect(runProc(["true"], { timeoutMs: 0 })).rejects.toThrow(
			/timeoutMs/,
		);
		await expect(
			runProc(["true"], { timeoutMs: Number.POSITIVE_INFINITY }),
		).rejects.toThrow(/timeoutMs/);
	});

	test("timeout kills the whole process GROUP, not just the leader", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-proc-"));
		const pidFile = join(dir, "child.pid");
		try {
			const res = await runProc(
				["bash", "-c", `sleep 999 & echo $! > ${pidFile}; wait`],
				{ timeoutMs: 300 },
			);
			expect(res.timedOut).toBe(true);
			const childPid = Number((await readFile(pidFile, "utf8")).trim());
			expect(childPid).toBeGreaterThan(0);
			// the background sleep was a sibling in the child's process group,
			// a leader-only kill would have orphaned it for 999 s
			expect(await waitForDeath(childPid)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("output is tail-kept: head dropped, marker in front, real tail intact", async () => {
		const cap = 64 * 1024;
		const res = await runProc(
			["bash", "-c", "yes | head -c 200000; printf THE_REAL_TAIL"],
			{ maxOutputBytes: cap },
		);
		expect(res.exitCode).toBe(0);
		expect(res.timedOut).toBe(false);
		expect(res.truncated).toBe(true);
		expect(res.stdout.startsWith(TRUNCATION_MARKER)).toBe(true);
		expect(res.stdout.endsWith("THE_REAL_TAIL")).toBe(true);
		const kept = Buffer.byteLength(res.stdout.slice(TRUNCATION_MARKER.length));
		expect(kept).toBeLessThanOrEqual(cap);
	});

	test("small output is passed through untouched", async () => {
		const res = await runProc(["bash", "-c", "printf hello; printf world >&2"]);
		expect(res.stdout).toBe("hello");
		expect(res.stderr).toBe("world");
		expect(res.truncated).toBe(false);
		expect(res.timedOut).toBe(false);
		expect(res.exitCode).toBe(0);
	});

	test("abort signal kills the process without marking a timeout", async () => {
		const ctl = new AbortController();
		setTimeout(() => ctl.abort(), 100);
		const t0 = Date.now();
		const res = await runProc(["sleep", "999"], {
			timeoutMs: 60_000,
			signal: ctl.signal,
		});
		expect(Date.now() - t0).toBeLessThan(4000);
		expect(res.timedOut).toBe(false);
		expect(res.exitCode).not.toBe(0);
	});

	test("an already-aborted signal kills immediately", async () => {
		const ctl = new AbortController();
		ctl.abort();
		const t0 = Date.now();
		const res = await runProc(["sleep", "999"], { signal: ctl.signal });
		expect(Date.now() - t0).toBeLessThan(4000);
		expect(res.timedOut).toBe(false);
	});

	test("input piping", async () => {
		const res = await runProc(["cat"], { input: "hello\nworld" });
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("hello\nworld");
	});

	test("nonzero exit codes come back verbatim", async () => {
		const res = await runProc(["bash", "-c", "exit 7"]);
		expect(res.exitCode).toBe(7);
		expect(res.timedOut).toBe(false);
	});
});

describe("spawn failures are results, not exceptions", () => {
	test("a cwd that does not exist reports exit 127 instead of throwing", async () => {
		// Callers legitimately probe paths that may not exist yet (the merge
		// queue asks whether its integration worktree is a repo). Bun.spawn
		// throws there, while every caller is written against ProcResult.
		const r = await runProc(["git", "status"], {
			cwd: "/definitely/not/a/real/path",
			timeoutMs: 5000,
		});
		expect(r.exitCode).toBe(127);
		expect(r.stderr.length).toBeGreaterThan(0);
		expect(r.timedOut).toBe(false);
	});

	test("a binary that does not exist reports exit 127", async () => {
		const r = await runProc(["mfw-no-such-binary-xyz"], { timeoutMs: 5000 });
		expect(r.exitCode).toBe(127);
	});
});
