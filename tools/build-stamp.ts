/**
 * The stamp a build writes into itself (`packages/core/src/build-info.ts`).
 *
 * Reproducible where it can be: the time is `SOURCE_DATE_EPOCH` when set, else
 * the commit time of `HEAD`, never the wall clock of a checkout in git. Only a
 * tree outside git falls back to the current time. The commit is
 * `MFW_BUILD_GIT_SHA` when set (a build without the repository, such as Nix).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildStamp } from "../packages/core/src/build-info.ts";

function git(root: string, args: string[]): string | null {
	// Node APIs only: Vite loads this from its config, which may run under node.
	const r = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1" },
	});
	return r.status === 0 ? r.stdout.trim() : null;
}

/** Seconds since the epoch for the build time, and where they came from. */
export function buildEpoch(
	root: string,
	env: Record<string, string | undefined> = process.env,
): number {
	const fromEnv = env.SOURCE_DATE_EPOCH;
	if (fromEnv !== undefined && fromEnv !== "") {
		if (!/^\d+$/.test(fromEnv)) {
			throw new Error(
				`SOURCE_DATE_EPOCH="${fromEnv}" is not a whole number of seconds`,
			);
		}
		return Number(fromEnv);
	}
	const commit = git(root, ["log", "-1", "--format=%ct"]);
	if (commit && /^\d+$/.test(commit)) return Number(commit);
	return Math.floor(Date.now() / 1000);
}

export function packageVersion(packageJson: string): string {
	const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
		version?: unknown;
	};
	return typeof parsed.version === "string" ? parsed.version : "unknown";
}

export function buildStampFor(
	root: string,
	kind: BuildStamp["kind"],
	extra: Partial<BuildStamp> = {},
	env: Record<string, string | undefined> = process.env,
): BuildStamp {
	return {
		kind,
		version: packageVersion(join(root, "package.json")),
		// A builder without the repository (the Nix sandbox) passes the commit in.
		gitSha:
			env.MFW_BUILD_GIT_SHA || (git(root, ["rev-parse", "HEAD"]) ?? "unknown"),
		buildTime: new Date(buildEpoch(root, env) * 1000).toISOString(),
		bunVersion: process.versions.bun ?? "none",
		...extra,
	};
}

/** The define that carries a stamp into a bundle. */
export function stampDefine(stamp: BuildStamp): Record<string, string> {
	return { __MFW_BUILD__: JSON.stringify(stamp) };
}
