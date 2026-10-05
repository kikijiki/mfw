import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const WORKER = join(import.meta.dir, "host-resource-child.ts");

type Child = ReturnType<typeof Bun.spawn>;

interface ChildObservation {
	resultPath: string;
	exitCode: number | null;
	stdout: Promise<string>;
	stderr: Promise<string>;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return false;
		throw error;
	}
}

function processStartTime(statLine: string): string | null {
	const close = statLine.lastIndexOf(")");
	if (close < 0) return null;
	return (
		statLine
			.slice(close + 1)
			.trim()
			.split(/\s+/)[19] ?? null
	);
}

export class HostProcessHarness {
	readonly root = join(tmpdir(), `mfw-host-process-${randomUUID()}`);
	private readonly children = new Set<Child>();
	private readonly observations = new Map<string, ChildObservation>();
	private readonly homes = new Set<string>();
	private sequence = 0;

	async initialize(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
	}

	path(label: string): string {
		return join(
			this.root,
			`${String(++this.sequence).padStart(3, "0")}-${label}`,
		);
	}

	trackHome(home: string): void {
		this.homes.add(home);
	}

	async spawn(config: Record<string, unknown>): Promise<{
		child: Child;
		readyPath: string;
		resultPath: string;
		configPath: string;
	}> {
		const readyPath = this.path("ready.json");
		const resultPath = this.path("result.json");
		const configPath = this.path("config.json");
		await writeFile(
			configPath,
			`${JSON.stringify({ ...config, readyPath, resultPath })}\n`,
			{ mode: 0o600 },
		);
		const child = Bun.spawn([process.execPath, WORKER, configPath], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, MFW_PROCESS_HARNESS: "1" },
		});
		const observation: ChildObservation = {
			resultPath,
			exitCode: null,
			// Consume both pipes immediately so a verbose or failing child cannot block
			// while the parent waits for its readiness/result artifact.
			stdout: new Response(child.stdout).text(),
			stderr: new Response(child.stderr).text(),
		};
		this.observations.set(readyPath, observation);
		this.observations.set(resultPath, observation);
		this.children.add(child);
		void child.exited.then((exitCode) => {
			observation.exitCode = exitCode;
			this.children.delete(child);
		});
		return { child, readyPath, resultPath, configPath };
	}

	private async waitForArtifact(
		path: string,
		label: string,
		timeoutMs: number,
	): Promise<void> {
		const observation = this.observations.get(path);
		const deadline = performance.now() + timeoutMs;
		for (;;) {
			if (await exists(path)) return;
			if (
				label === "readiness" &&
				observation &&
				(await exists(observation.resultPath))
			) {
				const result = await readFile(observation.resultPath, "utf8");
				throw new Error(`child exited before readiness: ${result.trim()}`);
			}
			if (
				observation?.exitCode !== null &&
				observation?.exitCode !== undefined
			) {
				const [stdout, stderr] = await Promise.all([
					observation.stdout,
					observation.stderr,
				]);
				throw new Error(
					[
						`child exited with code ${observation.exitCode} before ${label} ${path}`,
						stdout.trim() && `stdout: ${stdout.trim()}`,
						stderr.trim() && `stderr: ${stderr.trim()}`,
					]
						.filter(Boolean)
						.join("\n"),
				);
			}
			if (performance.now() >= deadline)
				throw new Error(`timed out: child ${label} ${path}`);
			await Bun.sleep(10);
		}
	}

	async waitReady<T = unknown>(path: string, timeoutMs = 20_000): Promise<T> {
		await this.waitForArtifact(path, "readiness", timeoutMs);
		return JSON.parse(await readFile(path, "utf8")) as T;
	}

	async result<T = unknown>(path: string, timeoutMs = 20_000): Promise<T> {
		await this.waitForArtifact(path, "result", timeoutMs);
		return JSON.parse(await readFile(path, "utf8")) as T;
	}

	async exit(child: Child, timeoutMs = 20_000): Promise<number> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				child.exited,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("child exit timed out")),
						timeoutMs,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async kill(child: Child): Promise<void> {
		try {
			child.kill("SIGKILL");
		} catch {
			// The bounded child may already have exited.
		}
		await this.exit(child, 5_000).catch(() => {});
	}

	async signal(path: string): Promise<void> {
		await writeFile(path, "go\n", { mode: 0o600 });
	}

	private async killRecordedWorkloads(home: string): Promise<void> {
		const dbPath = join(home, "host", "host.db");
		if (!(await exists(dbPath))) return;
		const client = createClient({ url: `file:${dbPath}`, intMode: "bigint" });
		try {
			const rows = await client.execute(
				"SELECT pid,process_start_time FROM leases WHERE pid IS NOT NULL AND state IN ('active','uncertain','releasing')",
			);
			for (const row of rows.rows) {
				const pid = Number(row.pid);
				const expected =
					typeof row.process_start_time === "string"
						? row.process_start_time
						: null;
				if (!Number.isSafeInteger(pid) || pid <= 1 || !expected) continue;
				try {
					const current = await readFile(`/proc/${pid}/stat`, "utf8");
					if (processStartTime(current) === expected)
						process.kill(pid, "SIGKILL");
				} catch {
					// Already absent is the desired cleanup state.
				}
			}
		} finally {
			client.close();
		}
	}

	async cleanup(): Promise<void> {
		for (const child of [...this.children]) await this.kill(child);
		for (const home of this.homes) {
			await this.killRecordedWorkloads(home).catch(() => {});
		}
		this.observations.clear();
		await rm(this.root, { recursive: true, force: true });
	}
}
