/**
 * The live host facts for a sandboxed agent launch. Read fresh per launch, so
 * a host that lost its user manager or bwrap is refused at that launch.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireHostTool } from "../sandbox.ts";
import type { AgentLaunchRequest } from "./agent-launch.ts";
import { TEMPORARY_FLEET_WRITABLE } from "./agent-profile.ts";
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

/** The allowlisted directories must exist to be bound; nothing else is touched. */
function ensureFleetDirs(req: Pick<AgentLaunchRequest, "mfwHome" | "cli">) {
	const fleet = join(req.mfwHome, "agents", req.cli);
	if (realOrNull(fleet) !== fleet) return;
	for (const rel of TEMPORARY_FLEET_WRITABLE[req.cli]) {
		mkdirSync(join(fleet, rel), { recursive: true, mode: 0o700 });
	}
}

export async function liveCompileHost(
	req: Pick<AgentLaunchRequest, "mfwHome" | "cli" | "stateDir">,
	binaries: readonly string[],
	allowedRoots: readonly string[],
): Promise<CompileHost> {
	ensureFleetDirs(req);
	const bwrapPath = requireHostTool("bwrap");
	const readers = liveHostReaders();
	const [userns, bwrap, systemd] = await Promise.all([
		detectUserns(readers),
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
		}),
		home,
		mfwHome: req.mfwHome,
		projectDbDirs: [req.stateDir],
		allowedRoots,
		realpath: realOrNull,
	};
}
