/**
 * The owner's approval of a project's development environment, modelled on
 * `direnv allow` and `mise trust`, but kept by mfw and never in the host's own
 * direnv or mise state (`~/.local/share/direnv`, `~/.config/mise` are not
 * touched; the env-build sandbox has a private home).
 *
 * An approval names one commit and the exact bytes of every environment file
 * at it (dev-env-sources.ts), plus a hash of the project's `env` config, which
 * holds the setup commands. Evaluation happens only at that commit. A later
 * commit may reuse the evaluated environment only while every approved file,
 * and the set of environment files itself, is byte-identical; otherwise the
 * approval does not cover it and the owner is asked again.
 *
 * Files the evaluation itself reports reading (direnv's watch list: sourced
 * files, `watch_file`, `dotenv`) are added after the first evaluation as
 * `discovered`. They are part of the approved commit, so recording them adds
 * no trust; it widens what counts as drift.
 *
 * One JSON file per project under `$MFW_HOME/env/approvals`, written whole and
 * atomically under a cross-process lock, so the CLI and the daemon cannot
 * lose each other's decision.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyedLock } from "@mfw/board-core";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import {
	detectEnvSource,
	type EnvDetection,
	type EnvFile,
	type EnvSourceKind,
	type EnvSourceSetting,
	hashCommitFiles,
} from "./dev-env-sources.ts";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;

const EnvFileSchema = z.strictObject({
	path: z.string().min(1).max(4096),
	oid: z.string().regex(OBJECT_ID),
	sha256: z.string().regex(HEX64),
});

export const EnvTrustRecordSchema = z.strictObject({
	version: z.literal(1),
	project: z.string().min(1).max(200),
	/** The primary checkout's real path: the key. */
	root: z.string().startsWith("/"),
	state: z.enum(["allowed", "denied"]),
	commit: z.string().regex(OBJECT_ID),
	source: z.enum(["direnv", "mise", "flake", "devenv"]).nullable(),
	files: z.array(EnvFileSchema).max(256),
	discovered: z.array(EnvFileSchema).max(256).default([]),
	/** sha256 of the project's canonical `env` config at approval. */
	configHash: z.string().regex(HEX64),
	at: z.string(),
	via: z.enum(["cli", "card"]),
});

export type EnvTrustRecord = z.infer<typeof EnvTrustRecordSchema>;

/** Key order carries no meaning in config. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as object)
			.sort()
			.map(
				(k) =>
					`${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Whether the project's config runs setup commands, which need an approval of their own. */
export function hasSetup(config: unknown): boolean {
	const setup = (config as { setup?: unknown } | null | undefined)?.setup;
	return Array.isArray(setup) && setup.length > 0;
}

/** The hash an approval binds the project's `env` config to. */
export function envConfigHash(config: unknown): string {
	return sha256(`mfw-env-config:1\n${canonical(config ?? {})}`);
}

/** Every file an approval covers, static and discovered, by path. */
export function approvedFiles(record: EnvTrustRecord): EnvFile[] {
	const byPath = new Map<string, EnvFile>();
	for (const f of [...record.files, ...record.discovered])
		byPath.set(f.path, f);
	return [...byPath.values()].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

/**
 * Identifies what was approved: the commit, the source, every file's bytes and
 * the config. The evaluated environment is cached under this.
 */
export function envFingerprint(
	record: Pick<
		EnvTrustRecord,
		"root" | "commit" | "source" | "files" | "configHash"
	>,
): string {
	const files = record.files.map((f) => `${f.path}\0${f.sha256}`).sort();
	return sha256(
		[
			"mfw-env:1",
			record.root,
			record.commit,
			record.source ?? "",
			record.configHash,
			...files,
		].join("\n"),
	);
}

export const envHome = (mfwHome: string): string => join(mfwHome, "env");

const projectKey = (root: string): string => sha256(root).slice(0, 24);

export class EnvTrustStore {
	private readonly dir: string;
	private readonly lock: KeyedLock;

	constructor(mfwHome: string) {
		// Nothing is created until something is written: the doctor reads this.
		this.dir = join(envHome(mfwHome), "approvals");
		this.lock = new KeyedLock(join(envHome(mfwHome), "locks"));
	}

	private path(root: string): string {
		return join(this.dir, `${projectKey(root)}.json`);
	}

	/** The record for a project, or null. A malformed file reads as no approval. */
	read(root: string): EnvTrustRecord | null {
		let text: string;
		try {
			text = readFileSync(this.path(root), "utf8");
		} catch {
			return null;
		}
		try {
			const parsed = EnvTrustRecordSchema.parse(JSON.parse(text));
			return parsed.root === root ? parsed : null;
		} catch {
			return null;
		}
	}

	private async write(record: EnvTrustRecord): Promise<void> {
		const valid = EnvTrustRecordSchema.parse(record);
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		await writeFileAtomic(
			this.path(valid.root),
			`${JSON.stringify(valid, null, 2)}\n`,
			{ mode: 0o600 },
		);
	}

	/** Replace the project's record with `record`, under the project's lock. */
	async put(record: EnvTrustRecord): Promise<void> {
		await this.lock.with(projectKey(record.root), () => this.write(record));
	}

	/**
	 * Add the files an evaluation reported reading, only if the record still
	 * approves the same thing: a re-allow or deny in between wins.
	 */
	async addDiscovered(
		root: string,
		fingerprint: string,
		discovered: EnvFile[],
	): Promise<EnvTrustRecord | null> {
		return this.lock.with(projectKey(root), async () => {
			const cur = this.read(root);
			if (cur?.state !== "allowed" || envFingerprint(cur) !== fingerprint) {
				return null;
			}
			const known = new Set(cur.files.map((f) => f.path));
			const next: EnvTrustRecord = {
				...cur,
				discovered: discovered
					.filter((f) => !known.has(f.path))
					.sort((a, b) => (a.path < b.path ? -1 : 1)),
			};
			await this.write(next);
			return next;
		});
	}
}

export interface EnvApprovalInput {
	project: string;
	root: string;
	/** A full commit id. */
	commit: string;
	setting: EnvSourceSetting;
	config: unknown;
	via: EnvTrustRecord["via"];
	now?: () => Date;
}

/** What `allow` would record, for the card and the CLI to show before it does. */
export async function proposeApproval(
	input: Omit<EnvApprovalInput, "via" | "now">,
): Promise<{ detection: EnvDetection; configHash: string }> {
	const detection = await detectEnvSource(
		input.root,
		input.commit,
		input.setting,
		{ lockfiles: hasSetup(input.config) },
	);
	return { detection, configHash: envConfigHash(input.config) };
}

/** Approve the environment at one commit. An unsupported setup cannot be approved. */
export async function allowEnv(
	store: EnvTrustStore,
	input: EnvApprovalInput,
): Promise<EnvTrustRecord> {
	const { detection, configHash } = await proposeApproval(input);
	if (detection.kind === "unsupported") {
		throw new Error(`${detection.reason}. Fix: ${detection.fix}`);
	}
	const record: EnvTrustRecord = {
		version: 1,
		project: input.project,
		root: input.root,
		state: "allowed",
		commit: input.commit,
		source: detection.kind === "none" ? null : detection.kind,
		files: detection.files,
		discovered: [],
		configHash,
		at: (input.now ?? (() => new Date()))().toISOString(),
		via: input.via,
	};
	await store.put(record);
	return record;
}

/** Refuse the project's environment until it is allowed again. */
export async function denyEnv(
	store: EnvTrustStore,
	input: Omit<EnvApprovalInput, "setting">,
): Promise<EnvTrustRecord> {
	const record: EnvTrustRecord = {
		version: 1,
		project: input.project,
		root: input.root,
		state: "denied",
		commit: input.commit,
		source: null,
		files: [],
		discovered: [],
		configHash: envConfigHash(input.config),
		at: (input.now ?? (() => new Date()))().toISOString(),
		via: input.via,
	};
	await store.put(record);
	return record;
}

export type EnvStatus =
	/** The commit declares no environment (or `env.source` is `none`). */
	| { state: "none" }
	| { state: "unsupported"; reason: string; fix: string }
	| { state: "not_approved"; detection: EnvDetection }
	| { state: "denied"; record: EnvTrustRecord }
	| {
			state: "drifted";
			record: EnvTrustRecord;
			detection: EnvDetection;
			/** Approved or new environment files whose bytes differ, or that came or went. */
			changed: string[];
			configChanged: boolean;
	  }
	| {
			state: "approved";
			record: EnvTrustRecord;
			fingerprint: string;
			source: EnvSourceKind | null;
	  };

/** Pure: the paths whose bytes differ between the approval and `now`. */
export function changedFiles(
	approved: readonly EnvFile[],
	now: readonly EnvFile[],
): string[] {
	const a = new Map(approved.map((f) => [f.path, f.sha256]));
	const b = new Map(now.map((f) => [f.path, f.sha256]));
	const out = new Set<string>();
	for (const [p, h] of a) if (b.get(p) !== h) out.add(p);
	for (const [p, h] of b) if (a.get(p) !== h) out.add(p);
	return [...out].sort();
}

/**
 * Whether the approval covers `commit`. Reads only the primary's objects.
 * `commit` may be the approved one or any later one.
 */
export async function envStatusAt(input: {
	store: EnvTrustStore;
	root: string;
	commit: string;
	setting: EnvSourceSetting;
	config: unknown;
}): Promise<EnvStatus> {
	const detection = await detectEnvSource(
		input.root,
		input.commit,
		input.setting,
		{ lockfiles: hasSetup(input.config) },
	);
	if (detection.kind === "unsupported") {
		return {
			state: "unsupported",
			reason: detection.reason,
			fix: detection.fix,
		};
	}
	const record = input.store.read(input.root);
	if (detection.kind === "none" && !hasSetup(input.config)) {
		// Nothing to evaluate or install. A denial still stands for a later commit that adds one.
		return { state: "none" };
	}
	if (!record) return { state: "not_approved", detection };
	if (record.state === "denied") return { state: "denied", record };
	const discoveredNow = await hashCommitFiles(
		input.root,
		input.commit,
		record.discovered.map((f) => f.path),
	);
	const changed = changedFiles(approvedFiles(record), [
		...detection.files,
		...discoveredNow,
	]);
	const configChanged = envConfigHash(input.config) !== record.configHash;
	const sourceChanged =
		record.source !== (detection.kind === "none" ? null : detection.kind);
	if (changed.length > 0 || configChanged || sourceChanged) {
		return {
			state: "drifted",
			record,
			detection,
			changed,
			configChanged,
		};
	}
	return {
		state: "approved",
		record,
		fingerprint: envFingerprint(record),
		source: record.source,
	};
}

/** Repository paths an approval protects: a merge changing one is ask-first. */
export function protectedEnvPaths(record: EnvTrustRecord | null): string[] {
	if (record?.state !== "allowed") return [];
	return approvedFiles(record).map((f) => f.path);
}
