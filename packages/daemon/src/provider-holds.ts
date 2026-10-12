import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import type { ProviderHold } from "./routing.ts";
import { serializeFileMutation } from "./serialized-file-mutation.ts";

/**
 * Machine-wide rate-limit holds, one per provider account, in
 * `$MFW_HOME/provider-holds.json`. A quota belongs to an account, and one
 * account serves every project on this machine, so a hold is not project
 * state: a Claude limit hit in project A holds Claude in project B too, and
 * never holds Codex anywhere.
 *
 * Keys are `routing.holdKeyOf(harness, endpoint)`: the harness id for the
 * subscription/CLI account (`claude-cli`, `codex-cli`) and `codex-cli@<id>` for
 * an OpenAI-compatible endpoint. Atomic replace + serialized mutate, as
 * `credentials.ts`; an absent file means no holds. The project-level
 * `dispatch_hold` (manual quiet periods, trigger `hold_dispatch`) still holds
 * every provider of that one project.
 */

const HoldSchema = z.object({
	until: z.number(),
	reason: z.string(),
	runId: z.string().optional(),
	project: z.string().optional(),
	since: z.number().optional(),
});

const FileSchema = z.object({
	version: z.literal(1),
	holds: z.record(z.string(), HoldSchema),
});

type HoldFile = z.infer<typeof FileSchema>;
export type StoredProviderHold = z.infer<typeof HoldSchema>;

export class ProviderHoldStore {
	constructor(
		private readonly path: string,
		private readonly now: () => number = () => Date.now(),
	) {}

	static at(mfwHome: string, now?: () => number): ProviderHoldStore {
		return new ProviderHoldStore(join(mfwHome, "provider-holds.json"), now);
	}

	private async load(): Promise<HoldFile> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, holds: {} };
			throw error;
		}
		try {
			return FileSchema.parse(JSON.parse(raw));
		} catch {
			// A corrupt holds file must not wedge dispatch; holds are advisory
			// timers, and the next rate limit writes a fresh one.
			return { version: 1, holds: {} };
		}
	}

	/** Hold `key` until `until`, keeping the furthest existing `until`. */
	async hold(
		key: string,
		hold: { until: number; reason: string; runId?: string; project?: string },
	): Promise<StoredProviderHold> {
		return serializeFileMutation(this.path, async () => {
			const file = await this.load();
			const now = this.now();
			for (const [k, h] of Object.entries(file.holds))
				if (h.until <= now) delete file.holds[k];
			const current = file.holds[key];
			const next =
				current && current.until >= hold.until
					? current
					: { ...hold, since: current?.since ?? now };
			file.holds[key] = next;
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`);
			return next;
		});
	}

	async clear(key: string): Promise<void> {
		await serializeFileMutation(this.path, async () => {
			const file = await this.load();
			if (!(key in file.holds)) return;
			delete file.holds[key];
			await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`);
		});
	}

	/** Every hold still in force. */
	async active(): Promise<Record<string, StoredProviderHold>> {
		const file = await serializeFileMutation(this.path, () => this.load());
		const now = this.now();
		return Object.fromEntries(
			Object.entries(file.holds).filter(([, h]) => h.until > now),
		);
	}

	/** A synchronous lookup over one snapshot, the shape `routeRun` takes. */
	async snapshot(): Promise<(key: string) => ProviderHold | null> {
		const holds = await this.active();
		return (key) => {
			const h = holds[key];
			return h ? { until: h.until, reason: h.reason } : null;
		};
	}
}
