import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { HarnessIdentity } from "@mfw/plugin-api/harness";
// A relative path: Bun.build inside the test runner fails on a second bundle
// that reaches this file through the workspace package name.
import { BUILTIN_HARNESS_MANIFESTS } from "../../../plugin-api/src/harness-builtins.ts";

/**
 * Confirms that a generically named binary on PATH (`agent`, `pi`) is the CLI
 * mfw means before it is reported as installed or launched. Shared by
 * detection (`detect.ts`), the ACP bridge (before it spawns the agent) and the
 * SSH host probe (`identityShell`), so the three agree.
 *
 * - `symlink-target`: the resolved path's file name. Cursor's installer makes
 *   `~/.local/bin/agent` (and the legacy `cursor-agent`) a symlink to
 *   `~/.local/share/cursor-agent/versions/<version>/cursor-agent`.
 * - `help-text`: a pattern the tool's own help output must match. pi's
 *   `--help` starts with "pi - AI coding assistant ...".
 */
export type BinaryIdentity =
	| { kind: "symlink-target"; basename: string; describe: string }
	| {
			kind: "help-text";
			args: readonly string[];
			pattern: RegExp;
			describe: string;
	  };

/** The runtime form of a manifest's identity; the regex is compiled here. */
function toBinaryIdentity(identity: HarnessIdentity): BinaryIdentity {
	return identity.kind === "symlink-target"
		? identity
		: {
				kind: "help-text",
				args: identity.args,
				pattern: new RegExp(identity.pattern, identity.flags),
				describe: identity.describe,
			};
}

const identities = new Map<string, BinaryIdentity>();

/** The identity a harness declares, one shared object per harness. */
export function harnessBinaryIdentity(id: string): BinaryIdentity | undefined {
	const known = identities.get(id);
	if (known) return known;
	// The bridge imports this file, so it reads the data without the validator.
	const declared = BUILTIN_HARNESS_MANIFESTS.find((m) => m.id === id)?.detect
		.identity;
	if (!declared) return undefined;
	const identity = toBinaryIdentity(declared);
	identities.set(id, identity);
	return identity;
}

export const CURSOR_AGENT_IDENTITY = harnessBinaryIdentity(
	"cursor-agent",
) as BinaryIdentity;

export const PI_IDENTITY = harnessBinaryIdentity("pi") as BinaryIdentity;

export type IdentityVerdict = { ok: true } | { ok: false; reason: string };

/** Pure check over facts already gathered (the resolved path, the help text). */
export function checkIdentity(
	identity: BinaryIdentity,
	bin: string,
	facts: { resolvedPath?: string | null; helpText?: string | null },
): IdentityVerdict {
	if (identity.kind === "symlink-target") {
		const resolved = facts.resolvedPath ?? "";
		if (basename(resolved) === identity.basename) return { ok: true };
		return {
			ok: false,
			reason: `\`${bin}\` on PATH is not ${identity.describe}: it resolves to ${resolved || "nothing"}`,
		};
	}
	const text = facts.helpText ?? "";
	if (identity.pattern.test(text)) return { ok: true };
	return {
		ok: false,
		reason: `\`${bin}\` on PATH is not ${identity.describe}: \`${bin} ${identity.args.join(" ")}\` does not say so`,
	};
}

/** Resolve symlinks; the path itself when it cannot be resolved. */
export function resolvedPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * POSIX sh that exits 0 only when `bin` on PATH has this identity. Used by the
 * SSH host probe, which already runs a login-PATH shell.
 */
export function identityShell(identity: BinaryIdentity, bin: string): string {
	if (identity.kind === "symlink-target") {
		return `[ "$(basename "$(readlink -f "$(command -v ${bin})")")" = ${shellQuote(identity.basename)} ]`;
	}
	const pattern = identity.pattern.source
		.replace(/\\b/g, "")
		.replace(/\(\?[a-z]+\)/g, "");
	return `${bin} ${identity.args.map(shellQuote).join(" ")} 2>/dev/null | grep -Eiq ${shellQuote(pattern)}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
