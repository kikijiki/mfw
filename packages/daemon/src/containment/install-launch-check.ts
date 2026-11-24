/**
 * What a compiled launcher checks about its own install before every launch
 * (security review REL-1 M2):
 *  - the whole install against its manifest and against the digests this
 *    `mfw` was built with, every time, not only when the server started: a
 *    mismatch refuses every launch;
 *  - that agents cannot write the install (`install-trust.ts`): an install
 *    that fails refuses autonomous launches unless the owner acknowledged that
 *    exact prefix, and warns on the others.
 *
 * From source or a bundle there is no compiled install, and nothing to check.
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildStamp } from "../../../core/src/build-info.ts";
import { loadConfig } from "../config.ts";
import { selfReExecs } from "./host-script.ts";
import {
	checkInstall,
	INSTALL_MANIFEST,
	installOfExecutable,
} from "./install-manifest.ts";
import {
	ACK_UNTRUSTED_INSTALL,
	type InstallTrustOptions,
	installTrustFix,
	installTrustProblems,
} from "./install-trust.ts";

export interface InstallLaunchCheckDeps {
	compiled: boolean;
	/** This executable, links resolved. */
	self: string;
	/** The owner's acknowledged prefix, if any. */
	acknowledged: () => Promise<string | undefined>;
	expected: { server?: string; runtime?: string; board?: string };
	trust?: InstallTrustOptions;
}

/** The digests this `mfw` was built with, for `checkInstall`. */
export function builtDigests(): InstallLaunchCheckDeps["expected"] {
	const integrity = buildStamp()?.integrity ?? {};
	return {
		...(integrity.server ? { server: integrity.server } : {}),
		...(integrity.runtime ? { runtime: integrity.runtime } : {}),
		...(integrity.board ? { board: integrity.board } : {}),
	};
}

export function liveInstallLaunchCheckDeps(
	mfwHome: string,
): InstallLaunchCheckDeps {
	return {
		compiled: selfReExecs(),
		self: realpathSync(process.execPath),
		acknowledged: async () =>
			(await loadConfig(mfwHome)).acknowledgeUntrustedInstall,
		expected: builtDigests(),
	};
}

export interface InstallLaunchCheck {
	/** Why the launch must not go ahead, or null. */
	refusal: string | null;
	/** Said once, when the launch goes ahead from an untrusted prefix. */
	warning: string | null;
}

export async function installLaunchCheck(
	approvalMode: "autonomous" | "interactive",
	d: InstallLaunchCheckDeps,
): Promise<InstallLaunchCheck> {
	if (!d.compiled) return { refusal: null, warning: null };
	const { prefix, libDir } = installOfExecutable(d.self);
	if (!existsSync(join(libDir, INSTALL_MANIFEST))) {
		return {
			refusal:
				"refusing to launch: this mfw has no install around it (a standalone executable runs no agents). Fix: install mfw with its server and runtime",
			warning: null,
		};
	}
	const check = checkInstall(libDir, { self: d.self, ...d.expected });
	if (!check.manifest || check.problems.length > 0) {
		return {
			refusal: `refusing to launch: the install does not verify: ${check.problems.join("; ")}. Fix: reinstall mfw`,
			warning: null,
		};
	}
	const trust = installTrustProblems(prefix, libDir, check.manifest, d.trust);
	if (trust.length === 0) return { refusal: null, warning: null };
	const why = `the install at ${prefix} could be changed by agents or any process of this user (${trust.join("; ")})`;
	const acknowledged = (await d.acknowledged()) === prefix;
	if (approvalMode === "autonomous" && !acknowledged) {
		return {
			refusal: `refusing an autonomous launch: ${why}. Fix: ${installTrustFix(prefix)}`,
			warning: null,
		};
	}
	return {
		refusal: null,
		warning: `${why}${acknowledged ? `; accepted by ${ACK_UNTRUSTED_INSTALL}` : ""}. Fix: ${installTrustFix(prefix)}`,
	};
}
