/**
 * The live host facts for a sandboxed agent launch. Read fresh per launch, so
 * a host that lost its user manager or bwrap is refused at that launch.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pinnedTool, requireHostTool } from "../sandbox.ts";
import type { AgentLaunchRequest } from "./agent-launch.ts";
import type { CompileHost } from "./compile-bwrap.ts";
import {
	detectArch,
	detectBwrap,
	detectSystemdUser,
	detectUserns,
	liveHostReaders,
} from "./host-caps.ts";
import { discoverToolchain } from "./toolchain.ts";

export const realOrNull = (p: string): string | null => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

export async function liveCompileHost(
	req: Pick<AgentLaunchRequest, "mfwHome" | "cli" | "stateDir">,
	binaries: readonly string[],
	allowedRoots: readonly string[],
): Promise<CompileHost> {
	const bwrapPath = requireHostTool("bwrap");
	const readers = liveHostReaders();
	const [userns, bwrap, systemd] = await Promise.all([
		detectUserns(readers, {
			bwrap: bwrapPath,
			bwrapReal: realOrNull(bwrapPath),
			trueBin: pinnedTool("true"),
		}),
		detectBwrap(readers, bwrapPath),
		detectSystemdUser(readers),
	]);
	const home = homedir();
	return {
		caps: { userns, bwrap, systemd, arch: detectArch(readers) },
		bwrapPath,
		envPath: requireHostTool("env"),
		systemdRunPath: requireHostTool("systemd-run"),
		toolchain: discoverToolchain({
			home,
			binaries,
			path: process.env.PATH ?? "",
			// The runtime the launcher itself runs on: a CLI installed outside the
			// store links against it. Taken from this process, not from any file.
			storeRoots: [realOrNull(process.execPath) ?? process.execPath],
		}),
		home,
		mfwHome: req.mfwHome,
		projectDbDirs: [req.stateDir],
		allowedRoots,
		realpath: realOrNull,
	};
}
