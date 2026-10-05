import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import type { ProjectIdentity } from "./types.ts";

export async function readKernelBootId(): Promise<string | null> {
	try {
		const value = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
		const id = value.trim();
		return id || null;
	} catch {
		return null;
	}
}

/** Stable, path/name-independent identity stored with the project's metadata. */
export async function stableProjectIdentity(
	mfwDir: string,
	now = Date.now(),
): Promise<ProjectIdentity> {
	const path = join(mfwDir, "state", "project.json");
	let raw: string | null = null;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	if (raw !== null) {
		let parsed: Partial<ProjectIdentity>;
		try {
			parsed = JSON.parse(raw) as Partial<ProjectIdentity>;
		} catch (error) {
			throw new Error(`project identity metadata is corrupt at ${path}`, {
				cause: error,
			});
		}
		if (
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			typeof parsed.createdAt === "number" &&
			Number.isFinite(parsed.createdAt)
		) {
			return { id: parsed.id, createdAt: parsed.createdAt };
		}
		throw new Error(`project identity metadata is invalid at ${path}`);
	}
	const identity = { id: crypto.randomUUID(), createdAt: now };
	await mkdir(join(mfwDir, "state"), { recursive: true });
	await writeFileAtomic(path, `${JSON.stringify(identity, null, 2)}\n`);
	return identity;
}
