import { afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	controlRootPath,
	pinnedTool,
	resetBwrapAvailableCache,
} from "../../src/sandbox.ts";

/**
 * Shared scaffolding for the security-review regression tests (wave 1, C):
 * a temporary HOME and workspace tree, planted binaries, and an environment that
 * is put back after every test. Nothing here touches the real home.
 */

export const mkfifoSync = (path: string, mode: number) => {
	spawnSync("mkfifo", ["-m", mode.toString(8), path]);
};

export const savedEnv = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};
const dirs: string[] = [];
export const uid = `${process.pid}-${Date.now()}`;
/** Call once at the top of a test file. */
export function installCleanup(): void {
	afterEach(cleanup);
}

async function cleanup() {
	process.env.PATH = savedEnv.PATH;
	process.env.HOME = savedEnv.HOME;
	if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
	resetBwrapAvailableCache();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
	// Control-dir records of this file's runs (the dir itself is shared with the host).
	try {
		for (const f of readdirSync(controlRootPath())) {
			if (f.includes(uid))
				await rm(join(controlRootPath(), f), { force: true });
		}
	} catch {}
}

export async function usable(): Promise<string | null> {
	const bwrap = pinnedTool("bwrap");
	if (!bwrap) return "no bwrap";
	const r = Bun.spawnSync([
		bwrap,
		"--unshare-all",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}

export async function fakeHome() {
	const base = await mkdtemp(join(tmpdir(), "mfw-xfix-"));
	dirs.push(base);
	const home = join(base, "home");
	mkdirSync(join(home, "bin"), { recursive: true });
	const mk = (name: string) => {
		const p = join(base, name);
		mkdirSync(p, { recursive: true });
		return p;
	};
	return { base, home, mk };
}

/** A planted executable that records that it ran, then does the real thing. */
export function plant(dir: string, name: string, marker: string) {
	const real = Bun.which(name, { PATH: savedEnv.PATH ?? "" });
	const path = join(dir, name);
	writeFileSync(
		path,
		`#!/bin/sh\necho ${name} >> '${marker}'\n${real ? `exec '${real}' "$@"` : "exit 0"}\n`,
	);
	chmodSync(path, 0o755);
}

export async function waitFor(
	cond: () => boolean | Promise<boolean>,
	ms = 15_000,
) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await cond()) return true;
		await Bun.sleep(25);
	}
	return false;
}

export const baseSpec = (
	base: string,
	runId: string,
	runDir: string,
	cwd: string,
) => ({
	runId,
	runDir,
	cwd,
	projectRoot: base,
	agentArgv: ["true"],
	env: {},
	steer: false,
	approvalMode: "interactive" as const,
});
