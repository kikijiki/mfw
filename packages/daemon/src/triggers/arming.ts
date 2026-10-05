import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";

/**
 * The arming store, `~/.local/share/mfw/triggers/<project>.json`.
 *
 * A trigger definition in the repository is inert until an operator arms it
 * here, in the daemon's home outside every repository. Arming pins the
 * definition's sha256, so a later edit breaks the pin and disarms the trigger
 * loudly. Same shape as `notify.ts`'s `command` sink: a shell string read from
 * the daemon home, never from the project.
 *
 * Limit: an agent with host RCE runs as the daemon's uid and can write this
 * file too. This raises the cost from "edit a merged file" to "escape the
 * worktree and forge a pin", and makes the latter visible.
 *
 * An auto-disarmed record is kept, not deleted; otherwise hash drift would read
 * as "present, not armed" on the next refresh and the inbox item would vanish
 * before anyone saw it.
 */

const DisarmSchema = z.object({
	at: z.number(),
	reason: z.enum(["hash-drift", "definition-removed", "unloadable"]),
	/** The hash found on disk when the pin broke; absent if the file is gone. */
	foundHash: z.string().optional(),
});

/**
 * "This trigger's last delivery died" stamp. Kept here, not only in
 * `trigger_deliveries`, so the inbox item renders from one small JSON read.
 */
const FailingSchema = z.object({
	at: z.number(),
	detail: z.string(),
	/** The definition's `on_failure: hold_dispatch` when it died; bumps the
	 *  inbox item to `critical` since dispatch is stopped. */
	holdDispatch: z.boolean(),
});

const RecordSchema = z.object({
	hash: z.string(),
	/** Exact bytes approved for this hash. Absent only on older records;
	 * reconcile backfills it when the hash still matches. */
	definition: z.string().optional(),
	armedAt: z.number(),
	armedBy: z.string(),
	/** Secret names granted. Requesting an ungranted secret refuses dispatch. */
	secrets: z.array(z.string()).default([]),
	disarmed: DisarmSchema.optional(),
	failing: FailingSchema.optional(),
});

const FileSchema = z.record(z.string(), RecordSchema);

export type ArmingRecord = z.infer<typeof RecordSchema>;
export type DisarmReason = z.infer<typeof DisarmSchema>["reason"];
export type ArmingFile = Record<string, ArmingRecord>;

/** Store path; the project name is sanitized so it cannot escape the directory. */
export function armingPath(mfwHome: string, project: string): string {
	const safe = project.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "_";
	return join(mfwHome, "triggers", `${safe}.json`);
}

export class ArmingStore {
	constructor(private readonly path: string) {}

	static at(mfwHome: string, project: string): ArmingStore {
		return new ArmingStore(armingPath(mfwHome, project));
	}

	async load(): Promise<ArmingFile> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch {
			return {}; // nothing armed in this project yet
		}
		try {
			return FileSchema.parse(JSON.parse(raw));
		} catch (e) {
			// Fail loudly like credentials.json; treating it as empty would
			// silently disarm every trigger.
			throw new Error(
				`trigger arming file ${this.path} is malformed: ${
					e instanceof Error ? e.message : e
				}`,
			);
		}
	}

	private async save(file: ArmingFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`, {
			mode: 0o600,
		});
	}

	/** Pin `hash` and grant `secrets`. Re-arming clears any disarm stamp. */
	async arm(
		defId: string,
		hash: string,
		opts: { by?: string; secrets?: string[]; definition?: string } = {},
	): Promise<ArmingRecord> {
		const file = await this.load();
		const record: ArmingRecord = {
			hash,
			...(opts.definition === undefined ? {} : { definition: opts.definition }),
			armedAt: Date.now(),
			armedBy: opts.by ?? "operator",
			secrets: opts.secrets ?? [],
		};
		file[defId] = record;
		await this.save(file);
		return record;
	}

	/** Backfill `definition` on an older record. Caller must already have
	 * established that the pinned hash equals the current definition's. */
	async rememberDefinition(defId: string, definition: string): Promise<void> {
		const file = await this.load();
		const record = file[defId];
		if (!record || record.definition !== undefined) return;
		record.definition = definition;
		await this.save(file);
	}

	/** Operator disarm: the record goes entirely, so the trigger reads as
	 *  "present, not armed" rather than "something changed under you". */
	async disarm(defId: string): Promise<void> {
		const file = await this.load();
		if (!(defId in file)) return;
		delete file[defId];
		await this.save(file);
	}

	/** Automatic disarm: keep the record, stamp why. Idempotent for the same
	 *  reason and hash, so the event and inbox item fire once per drift. */
	async autoDisarm(
		defId: string,
		reason: DisarmReason,
		foundHash?: string,
	): Promise<{ changed: boolean; record: ArmingRecord | null }> {
		const file = await this.load();
		const record = file[defId];
		if (!record) return { changed: false, record: null };
		if (
			record.disarmed?.reason === reason &&
			record.disarmed.foundHash === foundHash
		) {
			return { changed: false, record };
		}
		record.disarmed = { at: Date.now(), reason, foundHash };
		await this.save(file);
		return { changed: true, record };
	}

	/** A delivery reached terminal failure (dead-lettered or no retries left).
	 *  No-op if not armed. */
	async markFailing(
		defId: string,
		detail: string,
		holdDispatch: boolean,
	): Promise<void> {
		const file = await this.load();
		const record = file[defId];
		if (!record) return;
		record.failing = { at: Date.now(), detail, holdDispatch };
		await this.save(file);
	}

	/** A delivery succeeded: clear the failing stamp. Unlike `disarmed`, this
	 *  one is not sticky. */
	async clearFailing(defId: string): Promise<void> {
		const file = await this.load();
		const record = file[defId];
		if (!record?.failing) return;
		record.failing = undefined;
		await this.save(file);
	}
}
