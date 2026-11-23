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
 *
 * A rate-limit or login message from a run is sandbox-reported: an agent can
 * forge it. {@link ProviderHoldStore.report} therefore holds only the reporting
 * project, for a short time, and becomes machine-wide only when a second
 * project reports the same account within a few minutes.
 */

/** The longest a hold taken from an agent's own report can last unconfirmed. */
export const MAX_REPORTED_HOLD_MS = 60 * 60_000;
/** Used when a report names no usable reset time. */
const REPORTED_HOLD_FALLBACK_MS = 15 * 60_000;
/** How close together two projects' reports must be to confirm each other. */
export const REPORT_CONFIRM_WINDOW_MS = 15 * 60_000;
const MAX_REPORTS_PER_KEY = 32;

/** The hold of one account in one project. Never read as a machine-wide key. */
export function projectHoldKey(key: string, project: string): string {
	return `${key}#project:${project}`;
}

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
	/** Recent agent reports per account, for the two-project confirmation. */
	reports: z
		.record(
			z.string(),
			z.array(z.object({ project: z.string(), at: z.number() })),
		)
		.optional(),
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

	private place(
		file: HoldFile,
		key: string,
		hold: { until: number; reason: string; runId?: string; project?: string },
	): StoredProviderHold {
		const now = this.now();
		for (const [k, h] of Object.entries(file.holds))
			if (h.until <= now) delete file.holds[k];
		const current = file.holds[key];
		const next =
			current && current.until >= hold.until
				? current
				: { ...hold, since: current?.since ?? now };
		file.holds[key] = next;
		return next;
	}

	private async save(file: HoldFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`);
	}

	/**
	 * Hold `key` machine-wide until `until`, keeping the furthest existing
	 * `until`. For host-observed facts only; an agent's claim goes to `report`.
	 */
	async hold(
		key: string,
		hold: { until: number; reason: string; runId?: string; project?: string },
	): Promise<StoredProviderHold> {
		return serializeFileMutation(this.path, async () => {
			const file = await this.load();
			const next = this.place(file, key, hold);
			await this.save(file);
			return next;
		});
	}

	/**
	 * Record an agent's rate-limit or login report. The hold is clamped and
	 * covers the reporting project, unless another project reported the same
	 * account recently. `confirmedUntil` applies only to that confirmed case.
	 */
	async report(
		key: string,
		report: {
			project: string;
			until: number;
			reason: string;
			runId?: string;
			confirmedUntil?: number;
		},
	): Promise<{ scope: "project" | "machine"; key: string; until: number }> {
		return serializeFileMutation(this.path, async () => {
			const file = await this.load();
			const now = this.now();
			const recent = (file.reports?.[key] ?? []).filter(
				(r) => now - r.at <= REPORT_CONFIRM_WINDOW_MS && r.at <= now,
			);
			recent.push({ project: report.project, at: now });
			file.reports = {
				...file.reports,
				[key]: recent.slice(-MAX_REPORTS_PER_KEY),
			};
			const confirmed = new Set(recent.map((r) => r.project)).size >= 2;
			const usable = Number.isFinite(report.until) && report.until > now;
			const clamped = usable
				? Math.min(report.until, now + MAX_REPORTED_HOLD_MS)
				: now + REPORTED_HOLD_FALLBACK_MS;
			const until = confirmed ? (report.confirmedUntil ?? clamped) : clamped;
			const holdKey = confirmed ? key : projectHoldKey(key, report.project);
			const next = this.place(file, holdKey, {
				until,
				reason: report.reason,
				project: report.project,
				...(report.runId ? { runId: report.runId } : {}),
			});
			await this.save(file);
			return {
				scope: confirmed ? "machine" : "project",
				key: holdKey,
				until: next.until,
			};
		});
	}

	/** The routing view of one project: machine holds plus its own. */
	forProject(project: string): {
		snapshot(): Promise<(key: string) => ProviderHold | null>;
	} {
		return {
			snapshot: async () => {
				const holds = await this.active();
				return (key) => {
					const candidates = [
						holds[key],
						holds[projectHoldKey(key, project)],
					].filter((h): h is StoredProviderHold => h !== undefined);
					if (candidates.length === 0) return null;
					const h = candidates.reduce((a, b) => (b.until > a.until ? b : a));
					return { until: h.until, reason: h.reason };
				};
			},
		};
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
