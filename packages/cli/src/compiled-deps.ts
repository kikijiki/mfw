/**
 * `mfw`'s dependencies as a compiled executable: where its install is, how it
 * starts the server, which `mfw-board` it runs, and what `mfw version` says.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildStamp } from "../../core/src/build-info.ts";
import { HOST_BUN_FLAGS } from "../../daemon/src/containment/host-script.ts";
import { builtDigests } from "../../daemon/src/containment/install-launch-check.ts";
import {
	checkInstall,
	fileMismatch,
	installOfExecutable,
	installPath,
	readInstallManifest,
} from "../../daemon/src/containment/install-manifest.ts";
import {
	installTrustFix,
	installTrustProblems,
} from "../../daemon/src/containment/install-trust.ts";
import { verifyEmbeddedMigrations } from "../../db/src/migration-source.ts";
import type { EmbeddedPayload } from "./embedded.ts";
import { liveHostExecContext, runHostEntry } from "./host-exec.ts";
import { type Deps, inProcessCommands } from "./main.ts";

/** This executable, with links resolved: its install is found from here. */
export function selfExecutable(): string {
	return realpathSync(process.execPath);
}

/** The digest of what `mfw` embeds, for `mfw version` and the doctor. */
export function embeddedScriptsDigest(scripts: Record<string, string>): string {
	const h = createHash("sha256");
	for (const id of Object.keys(scripts).sort()) {
		h.update(`${id}\0${scripts[id]}\0`);
	}
	return h.digest("hex");
}

/**
 * The server of this install: its pinned runtime running its bundle, after
 * the whole install checks against its manifest and against the digests this
 * executable was built with.
 */
export function compiledServerCommand(
	self: string,
): { argv: string[]; cwd: string } | { error: string } {
	const { prefix, libDir } = installOfExecutable(self);
	const check = checkInstall(libDir, { self, ...builtDigests() });
	if (!check.manifest || check.problems.length > 0) {
		return {
			error: `refusing to start the server: ${check.problems.join("; ")}. Fix: reinstall mfw (a standalone mfw without its install has no server)`,
		};
	}
	const trust = installTrustProblems(prefix, libDir, check.manifest);
	if (trust.length > 0) {
		// Loud, and on every start. The launcher refuses autonomous runs from
		// here until the owner acknowledges this exact prefix.
		console.error(
			[
				"mfw: WARNING: this install is not safe from agents.",
				`mfw: ${prefix}: ${trust.join("; ")}`,
				"mfw: autonomous runs are refused until this is fixed or acknowledged.",
				`mfw: Fix: ${installTrustFix(prefix)}`,
			].join("\n"),
		);
	}
	const runtime = installPath(libDir, check.manifest.runtime);
	return {
		argv: [
			runtime,
			...HOST_BUN_FLAGS,
			"run",
			join(libDir, "server", "index.mjs"),
		],
		cwd: libDir,
	};
}

/** Why the `mfw-board` beside this executable must not run, or null. */
export function siblingBoardProblem(self: string, path: string): string | null {
	const { libDir } = installOfExecutable(self);
	let manifest: ReturnType<typeof readInstallManifest>;
	try {
		manifest = readInstallManifest(libDir);
	} catch (e) {
		return (e as Error).message;
	}
	// A standalone pair (both copied into one bin directory) has no manifest:
	// the sibling is exactly as trusted as this executable.
	if (!manifest) return null;
	try {
		if (installPath(libDir, manifest.mfwBoard) !== path) {
			return "it is not the install's mfw-board";
		}
	} catch (e) {
		return (e as Error).message;
	}
	return fileMismatch(path, manifest.mfwBoard.sha256);
}

function boardVersionLine(self: string): string {
	const sibling = join(dirname(self), "mfw-board");
	if (!existsSync(sibling)) return "mfw-board: not installed next to mfw";
	const problem = siblingBoardProblem(self, sibling);
	if (problem) return `mfw-board: ${problem}`;
	const r = Bun.spawnSync([sibling, "--version"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: "/nonexistent" },
	});
	const first = r.stdout.toString().split("\n")[0]?.trim();
	return r.exitCode === 0 && first
		? `${first} (${sibling})`
		: `mfw-board: ${sibling} did not report a version`;
}

export function compiledVersionLines(
	self: string,
	payload: EmbeddedPayload,
): string[] {
	const stamp = buildStamp();
	const lines = [
		`mfw ${stamp?.version ?? "unknown"} (compiled${stamp?.target ? `, ${stamp.target}` : ""})`,
		boardVersionLine(self),
		`git ${stamp?.gitSha ?? "unknown"}`,
		`built ${stamp?.buildTime ?? "unknown"}`,
		`bun ${Bun.version}`,
		"integrity:",
	];
	let migrations: string;
	try {
		const manifest = verifyEmbeddedMigrations();
		const count = Object.keys(manifest.files).length - 1;
		migrations = `${createHash("sha256").update(payload.migrations.manifest).digest("hex")} (${count} migration${count === 1 ? "" : "s"}, verified)`;
	} catch (e) {
		migrations = `FAILED: ${(e as Error).message}`;
	}
	lines.push(`  migrations manifest ${migrations}`);
	lines.push(`  libsql addon ${payload.libsql.sha256}`);
	lines.push(
		`  embedded scripts ${embeddedScriptsDigest(payload.scripts)} (${Object.keys(payload.scripts).sort().join(", ")})`,
	);
	for (const [name, digest] of Object.entries(stamp?.integrity ?? {}).sort()) {
		lines.push(`  ${name} ${digest}`);
	}
	const { prefix, libDir } = installOfExecutable(self);
	if (!existsSync(join(libDir, "install.json"))) {
		lines.push(
			"install: none (a standalone executable; `mfw server` needs an install)",
		);
	} else {
		const check = checkInstall(libDir, { self, ...builtDigests() });
		lines.push(
			check.problems.length === 0
				? `install: ${libDir} verified`
				: `install: ${libDir} FAILED: ${check.problems.join("; ")}`,
		);
		if (check.manifest) {
			lines.push(`  install mfw ${check.manifest.mfw.sha256}`);
			lines.push(`  install mfw-board ${check.manifest.mfwBoard.sha256}`);
			lines.push(
				`  install runtime ${check.manifest.runtime.sha256} (bun ${check.manifest.runtime.bunVersion})`,
			);
			lines.push(`  install server ${check.manifest.server.digest}`);
			const trust = installTrustProblems(prefix, libDir, check.manifest);
			lines.push(
				trust.length === 0
					? "install trust: ok (agents cannot write it)"
					: `install trust: NOT SAFE FROM AGENTS: ${trust.join("; ")}. Autonomous runs are refused unless acknowledged. Fix: ${installTrustFix(prefix)}`,
			);
		}
	}
	return lines;
}

export function compiledDeps(payload: EmbeddedPayload): Deps {
	const self = selfExecutable();
	const { libDir } = installOfExecutable(self);
	const serverEntry = join(libDir, "server", "index.mjs");
	return {
		env: process.env,
		selfDir: dirname(self),
		sourceBoardCli: null,
		serverEntry: existsSync(serverEntry) ? serverEntry : null,
		repoRoot: libDir,
		bun: process.execPath,
		...inProcessCommands(),
		siblingProblem: (path) => siblingBoardProblem(self, path),
		serverCommand: () => compiledServerCommand(self),
		versionLines: async () => compiledVersionLines(self, payload),
		runHostExec: (args) =>
			runHostEntry(args, {
				ctx: liveHostExecContext(true),
				err: (l) => console.error(l),
				write: (t) => process.stdout.write(t),
				content: (id) => {
					const text = payload.scripts[id];
					if (typeof text !== "string") throw new Error(`no embedded ${id}`);
					return text;
				},
			}),
	};
}
