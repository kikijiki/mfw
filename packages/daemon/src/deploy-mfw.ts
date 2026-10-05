import { constants, type Dirent } from "node:fs";
import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireKernelLock } from "./kernel-lock.ts";
import type { ProcResult } from "./proc.ts";
import { runProc } from "./proc.ts";

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const MARKER_FILE = ".mfw-deployment.json";
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface DeployCommandOptions {
	cwd?: string;
	timeoutMs?: number;
}

export type DeployCommand = (
	argv: string[],
	opts?: DeployCommandOptions,
) => Promise<ProcResult>;

export interface DeployMfwOptions {
	/** The checkout whose apps/start/.output is served by systemd. */
	repoRoot: string;
	/** Full commit id supplied by the trigger as MFW_SHA. */
	sha: string;
	run?: DeployCommand;
}

export interface DeployMfwResult {
	sha: string;
	status: "deployed" | "restart-arranged" | "unchanged";
	restartArranged: boolean;
}

interface DeploymentMarker {
	sha: string;
	restartArranged: boolean;
	/** Public files emitted by this release, excluding carried-forward assets. */
	publicAssets?: string[];
}

function safeAssetPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.split("/").some((part) => part === "" || part === "..")
	);
}

function commandText(argv: string[]): string {
	return argv.map((part) => JSON.stringify(part)).join(" ");
}

async function checked(
	run: DeployCommand,
	argv: string[],
	opts: DeployCommandOptions = {},
): Promise<ProcResult> {
	const result = await run(argv, {
		...opts,
		timeoutMs: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
	});
	if (result.exitCode !== 0 || result.timedOut) {
		const detail = result.timedOut
			? "timed out"
			: result.stderr.trim() || `exit ${result.exitCode}`;
		throw new Error(`${commandText(argv)} failed: ${detail}`);
	}
	return result;
}

async function readMarker(output: string): Promise<DeploymentMarker | null> {
	try {
		const value = JSON.parse(
			await readFile(join(output, MARKER_FILE), "utf8"),
		) as Partial<DeploymentMarker>;
		if (
			typeof value.sha === "string" &&
			typeof value.restartArranged === "boolean"
		) {
			return {
				sha: value.sha,
				restartArranged: value.restartArranged,
				...(Array.isArray(value.publicAssets) &&
				value.publicAssets.every(safeAssetPath)
					? { publicAssets: value.publicAssets }
					: {}),
			};
		}
	} catch {
		// Missing or malformed markers describe an artifact from the old deploy path.
	}
	return null;
}

async function listPublicAssets(output: string): Promise<string[]> {
	const publicRoot = join(output, "public");
	const assets: string[] = [];
	const visit = async (directory: string, prefix: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await visit(join(directory, entry.name), relativePath);
			} else if (entry.isFile()) {
				assets.push(relativePath);
			}
		}
	};
	await visit(publicRoot, "");
	return assets;
}

async function preservePreviousPublicAssets(
	previousOutput: string,
	stagedOutput: string,
	marker: DeploymentMarker | null,
): Promise<void> {
	// The marker separates the previous build's own files from carried-over
	// assets. Old deployments have no inventory, so their public tree is the legacy window.
	const previousAssets =
		marker?.publicAssets ?? (await listPublicAssets(previousOutput));
	for (const asset of previousAssets) {
		const source = join(previousOutput, "public", asset);
		const target = join(stagedOutput, "public", asset);
		await mkdir(dirname(target), { recursive: true });
		try {
			await copyFile(source, target, constants.COPYFILE_EXCL);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// The current build wins name collisions; a concurrently removed legacy file is skipped.
			if (code !== "EEXIST" && code !== "ENOENT") throw error;
		}
	}
}

async function writeMarker(
	output: string,
	marker: DeploymentMarker,
): Promise<void> {
	const markerPath = join(output, MARKER_FILE);
	const temporaryPath = join(
		output,
		`.mfw-deployment-${crypto.randomUUID()}.tmp`,
	);
	try {
		await writeFile(
			temporaryPath,
			`${JSON.stringify(marker, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, markerPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => {});
	}
}

async function arrangeRestart(
	run: DeployCommand,
	repoRoot: string,
	sha: string,
): Promise<void> {
	// Restarting synchronously from inside mfw would tear down the trigger
	// dispatcher before it records this command's result, so use a delayed timer.
	await checked(
		run,
		[
			"systemd-run",
			"--user",
			`--unit=mfw-deploy-restart-${sha.slice(0, 16).toLowerCase()}`,
			"--collect",
			"--on-active=2s",
			"systemctl",
			"--user",
			"restart",
			"mfw.service",
		],
		{ cwd: repoRoot, timeoutMs: 30_000 },
	);
}

async function deployedDescendant(
	run: DeployCommand,
	repoRoot: string,
	requestedSha: string,
	marker: DeploymentMarker | null,
): Promise<string | null> {
	if (!marker || !SHA_PATTERN.test(marker.sha) || marker.sha === requestedSha) {
		return null;
	}
	const ancestry = await run(
		["git", "merge-base", "--is-ancestor", requestedSha, marker.sha],
		{ cwd: repoRoot, timeoutMs: 30_000 },
	);
	if (ancestry.exitCode === 0 && !ancestry.timedOut) return marker.sha;
	if (ancestry.exitCode !== 1 || ancestry.timedOut) {
		const detail = ancestry.timedOut
			? "timed out"
			: ancestry.stderr.trim() || `exit ${ancestry.exitCode}`;
		throw new Error(`could not compare deployed revision: ${detail}`);
	}
	return null;
}

/**
 * Build MFW_SHA in a detached worktree, then replace the served Nitro output.
 * All external commands go through `run`, so tests never reach systemd.
 */
async function deployMfwLocked(
	options: DeployMfwOptions,
): Promise<DeployMfwResult> {
	const repoRoot = resolve(options.repoRoot);
	const requestedSha = options.sha.trim().toLowerCase();
	const run = options.run ?? runProc;
	if (!SHA_PATTERN.test(requestedSha)) {
		throw new Error("MFW_SHA must be a full hexadecimal commit id");
	}

	const servedOutput = join(repoRoot, "apps/start/.output");
	const existing = await readMarker(servedOutput);
	if (existing?.sha === requestedSha) {
		if (existing.restartArranged) {
			return {
				sha: requestedSha,
				status: "unchanged",
				restartArranged: false,
			};
		}
		await arrangeRestart(run, repoRoot, requestedSha);
		await writeMarker(servedOutput, {
			sha: requestedSha,
			restartArranged: true,
			...(existing.publicAssets ? { publicAssets: existing.publicAssets } : {}),
		});
		return {
			sha: requestedSha,
			status: "restart-arranged",
			restartArranged: true,
		};
	}
	const alreadyNewer = await deployedDescendant(
		run,
		repoRoot,
		requestedSha,
		existing,
	);
	if (alreadyNewer) {
		// A late replay of an older delivery must not roll back a newer release.
		return {
			sha: alreadyNewer,
			status: "unchanged",
			restartArranged: false,
		};
	}

	const revision = await checked(
		run,
		["git", "rev-parse", "--verify", `${requestedSha}^{commit}`],
		{ cwd: repoRoot, timeoutMs: 30_000 },
	);
	const resolvedSha = revision.stdout.trim().toLowerCase();
	if (resolvedSha !== requestedSha) {
		throw new Error(
			`MFW_SHA resolved to an unexpected commit: ${resolvedSha || "<empty>"}`,
		);
	}

	const scratch = await mkdtemp(join(tmpdir(), "mfw-deploy-"));
	const worktree = join(scratch, "worktree");
	let registeredWorktree = false;
	let stagedOutput: string | null = null;
	try {
		await checked(
			run,
			["git", "worktree", "add", "--detach", worktree, resolvedSha],
			{ cwd: repoRoot, timeoutMs: 60_000 },
		);
		registeredWorktree = true;
		await checked(run, ["bun", "install", "--frozen-lockfile"], {
			cwd: worktree,
		});
		await checked(run, ["bun", "run", "build"], { cwd: worktree });

		const builtOutput = join(worktree, "apps/start/.output");
		stagedOutput = join(
			dirname(servedOutput),
			`.output.deploy-${resolvedSha.slice(0, 12)}-${crypto.randomUUID()}`,
		);
		await mkdir(dirname(servedOutput), { recursive: true });
		await cp(builtOutput, stagedOutput, {
			recursive: true,
			errorOnExist: true,
		});
		const currentPublicAssets = await listPublicAssets(stagedOutput);
		await writeMarker(stagedOutput, {
			sha: resolvedSha,
			restartArranged: false,
			publicAssets: currentPublicAssets,
		});

		// Second ancestry check under the lock: an older, non-locking deploy script
		// may have published a descendant while the build ran.
		const latest = await readMarker(servedOutput);
		const becameNewer = await deployedDescendant(
			run,
			repoRoot,
			requestedSha,
			latest,
		);
		if (becameNewer) {
			return {
				sha: becameNewer,
				status: "unchanged",
				restartArranged: false,
			};
		}
		await preservePreviousPublicAssets(servedOutput, stagedOutput, latest);

		const previousOutput = join(
			dirname(servedOutput),
			`.output.previous-${crypto.randomUUID()}`,
		);
		let hadPrevious = false;
		try {
			await rename(servedOutput, previousOutput);
			hadPrevious = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(stagedOutput, servedOutput);
			stagedOutput = null;
		} catch (error) {
			if (hadPrevious) await rename(previousOutput, servedOutput);
			throw error;
		}

		await arrangeRestart(run, repoRoot, resolvedSha);
		await writeMarker(servedOutput, {
			sha: resolvedSha,
			restartArranged: true,
			publicAssets: currentPublicAssets,
		});
		if (hadPrevious) {
			await rm(previousOutput, { recursive: true, force: true }).catch(
				() => {},
			);
		}

		return {
			sha: resolvedSha,
			status: "deployed",
			restartArranged: true,
		};
	} finally {
		if (stagedOutput) {
			await rm(stagedOutput, { recursive: true, force: true }).catch(() => {});
		}
		if (registeredWorktree) {
			await run(["git", "worktree", "remove", "--force", worktree], {
				cwd: repoRoot,
				timeoutMs: 60_000,
			}).catch(() => undefined);
		}
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

/** Serializes publication for the served output across processes. The persistent sibling lock is never renamed, so every invocation queues on the same inode. */
export async function deployMfw(
	options: DeployMfwOptions,
): Promise<DeployMfwResult> {
	const repoRoot = resolve(options.repoRoot);
	const requestedSha = options.sha.trim().toLowerCase();
	if (!SHA_PATTERN.test(requestedSha)) {
		throw new Error("MFW_SHA must be a full hexadecimal commit id");
	}
	const lock = await acquireKernelLock(
		join(repoRoot, "apps/start/.mfw-deploy.lock"),
		{
			wait: true,
			metadata: {
				pid: process.pid,
				sha: requestedSha,
				acquiredAt: Date.now(),
			},
		},
	);
	try {
		return await deployMfwLocked({
			...options,
			repoRoot,
			sha: requestedSha,
		});
	} finally {
		await lock.release();
	}
}

if (import.meta.main) {
	const sha = process.env.MFW_SHA ?? "";
	deployMfw({ repoRoot: process.cwd(), sha })
		.then((result) => console.log(JSON.stringify(result)))
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
