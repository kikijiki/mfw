/**
 * The read side of the dev environment cache (dev-env-cache.ts): where an
 * entry lives, its schema, and what a sandbox profile gets from it. Kept apart
 * from the build so the launcher does not import the env-build runner.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DEV_ENV_LIMITS, isStorePath } from "./dev-env-rules.ts";
import { envHome } from "./dev-env-trust.ts";
import { readRegularFile } from "./safe-file.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export const DevEnvCaptureSchema = z.strictObject({
	version: z.literal(1),
	fingerprint: z.string().regex(HEX64),
	root: z.string().startsWith("/"),
	commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
	/** Null: no environment source, only setup on the host toolchain. */
	source: z.enum(["direnv", "mise", "flake", "devenv"]).nullable(),
	env: z.record(z.string(), z.string()),
	path: z.array(z.string()).max(DEV_ENV_LIMITS.maxPathEntries),
	closure: z
		.array(z.string().refine(isStorePath))
		.max(DEV_ENV_LIMITS.maxClosurePaths),
	closureMethod: z.enum(["nix-store", "reference-scan", "none"]),
	/** Whether `data/` holds anything a run needs. */
	hasData: z.boolean(),
	dropped: z
		.array(z.strictObject({ name: z.string(), reason: z.string() }))
		.max(4096),
	droppedPath: z.array(z.string()).max(4096),
	/** Repository files the evaluation reported reading. */
	watches: z.array(z.string()).max(DEV_ENV_LIMITS.maxWatches),
	/** Host-observed destinations, allowed and refused. */
	egress: z.strictObject({
		allowed: z.array(z.string()).max(256),
		denied: z.array(z.string()).max(256),
	}),
	gcRooted: z.boolean(),
	builtAt: z.string(),
});

export type DevEnvCapture = z.infer<typeof DevEnvCaptureSchema>;

const projectKey = (root: string): string =>
	createHash("sha256").update(root).digest("hex").slice(0, 24);

export function devEnvCacheDir(
	mfwHome: string,
	root: string,
	fingerprint: string,
): string {
	if (!HEX64.test(fingerprint)) throw new Error("not a fingerprint");
	return join(envHome(mfwHome), "cache", projectKey(root), fingerprint);
}

/** The cached capture, or null when there is none or it does not validate. */
export async function loadDevEnv(
	mfwHome: string,
	root: string,
	fingerprint: string,
): Promise<DevEnvCapture | null> {
	const file = join(devEnvCacheDir(mfwHome, root, fingerprint), "capture.json");
	const r = await readRegularFile(file, 8 * 1024 * 1024);
	if (!r || r.size > 8 * 1024 * 1024) return null;
	try {
		const parsed = DevEnvCaptureSchema.parse(
			JSON.parse(r.buffer.toString("utf8")),
		);
		return parsed.fingerprint === fingerprint && parsed.root === root
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** The profile section a run gets from a capture. */
export function devEnvSection(
	mfwHome: string,
	capture: DevEnvCapture,
): {
	env: Record<string, string>;
	path: string[];
	closure: string[];
	dataDir?: string;
} {
	return {
		env: { ...capture.env },
		path: [...capture.path],
		closure: [...capture.closure],
		...(capture.hasData
			? {
					dataDir: join(
						devEnvCacheDir(mfwHome, capture.root, capture.fingerprint),
						"data",
					),
				}
			: {}),
	};
}

/** The directory a run must be allowed to bind the data from. */
export function devEnvBindRoot(
	mfwHome: string,
	capture: DevEnvCapture,
): string {
	return devEnvCacheDir(mfwHome, capture.root, capture.fingerprint);
}
