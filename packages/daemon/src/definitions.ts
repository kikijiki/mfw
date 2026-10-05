import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { splitFrontmatter } from "@mfw/core";
import type { Logger } from "./log.ts";

/**
 * Shared loader for a directory of markdown definitions: scan, split
 * frontmatter, validate the id, hand off to a per-kind `parse` callback.
 *
 * Files are isolated: a bad one is quarantined with a human-readable reason
 * (and logged) without stopping the others.
 *
 * The content hash is over the raw file bytes (what the trigger arming record
 * pins), so a prose-body change also invalidates approval.
 */

export interface QuarantinedDefinition {
	/** File name within the definitions directory. */
	file: string;
	/** The id, when one could be read at all. */
	id: string | null;
	reason: string;
}

export interface DefinitionSource {
	file: string;
	id: string;
	/** Exact file content, retained by consumers that need an approval diff. */
	raw: string;
	/** Frontmatter as a mapping; `{}` when the file had none worth reading. */
	fm: Record<string, unknown>;
	/** Everything after the frontmatter, trimmed. */
	body: string;
	/** `sha256:<hex>` over the file's exact bytes. */
	hash: string;
}

export interface DefinitionLoad<T> {
	defs: T[];
	quarantined: QuarantinedDefinition[];
}

export interface DefinitionLoaderDeps<T> {
	/** Absolute path to the definitions directory; created if absent. */
	dir: string;
	/** The id grammar. */
	idRe: RegExp;
	/** Names this kind in log lines and quarantine reasons ("lifetime"). */
	kind: string;
	log: Logger;
	/** Turn a validated source into a definition. Return `null` to quarantine generically; throw to quarantine with the message. */
	parse: (src: DefinitionSource) => T | null;
}

export function hashDefinition(raw: string): string {
	return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

export class DefinitionLoader<T> {
	constructor(private readonly deps: DefinitionLoaderDeps<T>) {}

	async load(): Promise<DefinitionLoad<T>> {
		const { dir, log, kind } = this.deps;
		await mkdir(dir, { recursive: true });
		const out: DefinitionLoad<T> = { defs: [], quarantined: [] };
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			return out; // no directory (and mkdir could not make one): no definitions
		}
		for (const file of files.sort()) {
			if (!file.endsWith(".md")) continue;
			let id: string | null = null;
			try {
				const raw = await readFile(join(dir, file), "utf8");
				const { data, body } = splitFrontmatter(raw);
				const fm = (data ?? {}) as Record<string, unknown>;
				id = String(fm.id ?? file.replace(/\.md$/, ""));
				if (!this.deps.idRe.test(id)) {
					const reason = `${kind} id must match ${this.deps.idRe.source}, skipped`;
					log.warn({ file, id }, reason);
					out.quarantined.push({ file, id, reason });
					continue;
				}
				const def = this.deps.parse({
					file,
					id,
					raw,
					fm,
					body: body.trim(),
					hash: hashDefinition(raw),
				});
				if (def === null) {
					out.quarantined.push({
						file,
						id,
						reason: `${kind} definition was rejected`,
					});
					continue;
				}
				out.defs.push(def);
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				log.warn({ err: e, file }, `${kind} definition is malformed, skipped`);
				out.quarantined.push({ file, id, reason });
			}
		}
		return out;
	}
}
