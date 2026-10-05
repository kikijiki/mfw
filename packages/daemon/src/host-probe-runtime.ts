import { open, readdir } from "node:fs/promises";
import type { ProbeCapture } from "@mfw/core/host-observation";

export interface ProbeCommand {
	command: string;
	args: readonly string[];
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface ProbeCommandRunner {
	run(command: ProbeCommand, signal: AbortSignal): Promise<ProbeCapture>;
}

export type DirectoryCapture =
	| { outcome: "ok"; entries: string[]; truncated?: boolean }
	| {
			outcome: "permission-denied" | "execution-error";
			entries?: string[];
			truncated?: boolean;
	  };

export interface ProbeFiles {
	readFile(
		path: string,
		maxBytes: number,
		signal: AbortSignal,
	): Promise<ProbeCapture>;
	readDirectory(
		path: string,
		maxEntries: number,
		signal: AbortSignal,
	): Promise<DirectoryCapture>;
}

export interface ProbeTimer {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

export interface ProbeClock {
	now(): number;
	monotonicNow(): number;
	random(): number;
}

export interface HostProbeRuntime {
	commands: ProbeCommandRunner;
	files: ProbeFiles;
	timer: ProbeTimer;
	clock: ProbeClock;
}

function failure(error: unknown): ProbeCapture {
	const code = (error as { code?: string }).code;
	return {
		outcome:
			code === "EACCES" || code === "EPERM"
				? "permission-denied"
				: "execution-error",
	};
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	budget: { remaining: number },
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const value = next.value;
			const remaining = Math.max(0, Math.min(limit - total, budget.remaining));
			if (value.byteLength > remaining) {
				if (remaining > 0) {
					chunks.push(value.subarray(0, remaining));
					budget.remaining -= remaining;
				}
				total += remaining;
				truncated = true;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.byteLength;
			budget.remaining -= value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(bytes), truncated };
}

export function createProductionHostProbeRuntime(): HostProbeRuntime {
	const timer: ProbeTimer = {
		set: (callback, delayMs) => setTimeout(callback, delayMs),
		clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	return {
		clock: {
			now: () => Date.now(),
			monotonicNow: () => performance.now(),
			random: () => Math.random(),
		},
		timer,
		files: {
			async readFile(path, maxBytes, signal) {
				if (signal.aborted) return { outcome: "execution-error" };
				let handle: Awaited<ReturnType<typeof open>> | undefined;
				try {
					handle = await open(path, "r");
					const bytes = new Uint8Array(maxBytes + 1);
					const { bytesRead } = await handle.read(
						bytes,
						0,
						bytes.byteLength,
						0,
					);
					if (signal.aborted) return { outcome: "execution-error" };
					return {
						outcome: "ok",
						stdout: new TextDecoder().decode(
							bytes.subarray(0, Math.min(bytesRead, maxBytes)),
						),
						...(bytesRead > maxBytes ? { truncated: true } : {}),
					};
				} catch (error) {
					return failure(error);
				} finally {
					await handle?.close().catch(() => {});
				}
			},
			async readDirectory(path, maxEntries, signal) {
				if (signal.aborted) return { outcome: "execution-error" };
				try {
					const entries = await readdir(path);
					if (signal.aborted) return { outcome: "execution-error" };
					return {
						outcome: "ok",
						entries: entries.slice(0, maxEntries),
						...(entries.length > maxEntries ? { truncated: true } : {}),
					};
				} catch (error) {
					const mapped = failure(error);
					return {
						outcome:
							mapped.outcome === "permission-denied"
								? "permission-denied"
								: "execution-error",
					};
				}
			},
		},
		commands: {
			async run(request, signal) {
				if (signal.aborted) return { outcome: "execution-error" };
				let child: ReturnType<typeof Bun.spawn>;
				try {
					child = Bun.spawn([request.command, ...request.args], {
						stdout: "pipe",
						stderr: "pipe",
						env: process.env,
					});
				} catch (error) {
					if ((error as { code?: string }).code === "ENOENT")
						return { outcome: "missing-tool" };
					return failure(error);
				}

				let timedOut = false;
				let aborted = false;
				const terminate = () => {
					try {
						child.kill("SIGKILL");
					} catch {
						// best-effort: the bounded child already exited.
					}
				};
				const timeout = timer.set(() => {
					timedOut = true;
					terminate();
				}, request.timeoutMs);
				const onAbort = () => {
					aborted = true;
					terminate();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					const outputBudget = { remaining: request.maxOutputBytes };
					const [stdout, stderr, exitCode] = await Promise.all([
						readStreamBounded(
							child.stdout as ReadableStream<Uint8Array>,
							request.maxOutputBytes,
							outputBudget,
						),
						readStreamBounded(
							child.stderr as ReadableStream<Uint8Array>,
							request.maxOutputBytes,
							outputBudget,
						),
						child.exited,
					]);
					if (timedOut) return { outcome: "timeout" };
					if (aborted) return { outcome: "execution-error" };
					const truncated = stdout.truncated || stderr.truncated;
					if (truncated) terminate();
					if (exitCode === 0) {
						return {
							outcome: "ok",
							stdout: stdout.text,
							stderr: stderr.text,
							...(truncated ? { truncated: true } : {}),
						};
					}
					const message = `${stdout.text}\n${stderr.text}`.toLowerCase();
					return {
						outcome:
							message.includes("permission denied") ||
							message.includes("insufficient permission")
								? "permission-denied"
								: message.includes("not supported")
									? "unsupported"
									: "execution-error",
						stdout: stdout.text,
						stderr: stderr.text,
						exitCode,
						...(truncated ? { truncated: true } : {}),
					};
				} finally {
					timer.clear(timeout);
					signal.removeEventListener("abort", onAbort);
				}
			},
		},
	};
}
