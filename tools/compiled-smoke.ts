#!/usr/bin/env bun
/**
 * The production smoke checks against a COMPILED INSTALL.
 *
 *   bun run build && MFW_REQUIRE_LIVE_SANDBOX=1 bun run smoke:compiled
 *
 * Assembles a read-only install from this checkout's build in a temporary
 * prefix (`tools/install-build.ts`, with this bun as the pinned runtime), then:
 *  - checks `mfw version` verifies the whole install;
 *  - runs the auth smoke against its `mfw server` and compiled `mfw` CLI;
 *  - runs the caged agent launch through `mfw __host` (its own caged install);
 *  - reports the sizes and start-up times.
 * Every server runs on a private port and temporary home, and is stopped by
 * the smoke that started it. Nothing is downloaded.
 */

import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installBuild } from "./install-build.ts";

const ROOT = resolve(import.meta.dir, "..");

function writable(path: string): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) return;
	chmodSync(path, st.mode | 0o200);
	if (st.isDirectory())
		for (const c of readdirSync(path)) writable(join(path, c));
}

function timed(
	argv: string[],
	env: Record<string, string>,
): { ms: number; code: number; out: string } {
	const started = performance.now();
	const r = Bun.spawnSync(argv, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ms: performance.now() - started,
		code: r.exitCode,
		out: `${r.stdout.toString()}${r.stderr.toString()}`,
	};
}

function smoke(tool: string, env: Record<string, string>): number {
	const r = Bun.spawnSync(
		[process.execPath, "run", join(ROOT, "tools", tool)],
		{
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	return r.exitCode;
}

async function main(): Promise<number> {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-compiled-smoke-")));
	const prefix = join(base, "prefix");
	let failed = 0;
	try {
		const install = await installBuild({
			root: ROOT,
			prefix,
			runtime: process.execPath,
			skipBuild: true,
			readOnly: true,
		});
		const mfw = join(prefix, "bin/mfw");
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: join(base, "home"),
			MFW_HOME: join(base, "mfw-home"),
		};
		const version = timed([mfw, "version"], env);
		console.log(version.out.trimEnd());
		if (
			version.code !== 0 ||
			!version.out.includes(`install: ${install.libDir} verified`)
		) {
			console.error(
				"compiled-smoke: FAIL mfw version does not verify the install",
			);
			failed++;
		}
		const help = timed([join(prefix, "bin/mfw-board"), "--help"], env);
		const mfwHelp = timed([mfw, "--help"], env);
		if (smoke("auth-smoke.ts", { MFW_SMOKE_INSTALL: prefix }) !== 0) failed++;
		if (smoke("agent-launch-smoke.ts", { MFW_SMOKE_COMPILED: "1" }) !== 0)
			failed++;
		console.log("compiled-smoke report:");
		for (const [name, bytes] of Object.entries(install.sizes)) {
			console.log(`  ${name}: ${(bytes / 1e6).toFixed(1)} MB`);
		}
		console.log(`  mfw --help: ${mfwHelp.ms.toFixed(0)} ms`);
		console.log(`  mfw-board --help: ${help.ms.toFixed(0)} ms`);
		console.log(
			`  mfw version (hashes the whole install): ${version.ms.toFixed(0)} ms`,
		);
	} finally {
		writable(base);
		rmSync(base, { recursive: true, force: true });
	}
	console.log(
		`compiled-smoke: ${failed === 0 ? "passed" : `${failed} part(s) failed`}`,
	);
	return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(await main());
	} catch (e) {
		console.error(`compiled-smoke: ${(e as Error).message}`);
		process.exit(1);
	}
}
