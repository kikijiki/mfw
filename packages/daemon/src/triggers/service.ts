import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import {
	appendEvent,
	type EventBus,
	eventsSince,
	latestSeq,
	listEvents,
	type StoredEvent,
} from "@mfw/db/eventlog";
import { triggerCursor, triggerDeliveries } from "@mfw/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import type { QuarantinedDefinition } from "../definitions.ts";
import type { Logger } from "../log.ts";
import type { TriggerActionRegistry, TriggerDispatch } from "./actions.ts";
import { ArmingStore } from "./arming.ts";
import {
	CRON_NEVER_FIRED,
	cronCursorToLastFired,
	cronDue,
	cronTickEvent,
} from "./cron-source.ts";
import { loadTriggerDefs, type TriggerDef } from "./def.ts";
import { matchesEvent, type TriggerEvent } from "./events.ts";

/**
 * Project triggers: when EVENT happens, do ACTION.
 *
 *  - Definition: a file in the repo (`.mfw/triggers/<id>.md`).
 *  - Arming: a record in the daemon home pinned to the definition's sha256
 *    (the repo is not a trust boundary). Unarmed is inert; a changed armed
 *    definition disarms itself.
 *  - Cursor: a table; the event log is a transactional outbox, giving
 *    at-least-once delivery across restarts.
 *
 * The dispatch pass runs on the supervisor loop, not the scheduler (which is
 * opt-in), so a project with dispatch disabled still notifies when main goes red.
 * `trigger.*` events are absent from the triggerable allowlist, so a trigger
 * cannot fire off its own dispatch record.
 */

/** How far a single pass will scan for matching events, per window. */
const SCAN_WINDOW = 500;
/** How many windows one pass will drain looking for the newest match. */
const MAX_SCAN_WINDOWS = 40;
/** `catchup: all` past this degrades to `latest` and says so. */
export const MAX_CATCHUP_ALL = 50;
/** Retry backoff (§9.3): doubles per attempt, capped at five minutes. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** `on_failure: hold_dispatch` (§9.2), the spec's own worked example. */
const HOLD_DISPATCH_MS = 60 * 60_000;
/** `dryRun`'s default window (§9.4): "the last N events", not the whole log. */
const DRY_RUN_WINDOW = 200;

function backoffMs(attempt: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

/** Named definition or delivery does not exist; mapped to NOT_FOUND in `trpc.ts`. */
export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}

export type TriggerState =
	/** Definition present, hash matches the arming record: it will fire. */
	| "armed"
	/** Definition present, never armed. The commonest "why didn't it fire". */
	| "unarmed"
	/** Was armed; the file changed underneath it, so it disarmed itself. */
	| "drifted"
	/** `enabled: false` in the definition. */
	| "disabled"
	/** Armed, but requests a secret the arming record did not grant. */
	| "needs-secrets"
	/** An arming record whose definition file is gone. */
	| "orphaned"
	/** The file is there and failed to load. */
	| "quarantined";

export interface TriggerDeliveryView {
	id: string;
	eventSeq: number;
	eventType: string;
	state: string;
	attempt: number;
	startedAt: number;
	finishedAt: number | null;
	durationMs: number | null;
	detail: string | null;
	runId: string | null;
	skippedSeqs: number[];
}

/** Everything a screen needs to render and act on one trigger. `state` is explicit, never inferred from a missing field. */
export interface TriggerView {
	id: string;
	title: string;
	/** File name under `.mfw/triggers/`; null for an orphaned arming record. */
	file: string | null;
	state: TriggerState;
	/** Why it is not armed, in words someone can act on. */
	reason?: string;
	/** What `on:` says, rendered for display. */
	on?: string;
	action?: string;
	enabled: boolean;
	/** Hash of the file as it is now. */
	hash?: string;
	/** Exact current definition shown before approval. */
	definition?: string;
	/** Exact definition whose hash was last approved, when available. */
	approvedDefinition?: string;
	/** Hash the arming record pinned. */
	armedHash?: string;
	armedAt?: number;
	armedBy?: string;
	requestedSecrets: string[];
	grantedSecrets: string[];
	/** Requested but not granted, a refusal to dispatch, not an empty string. */
	missingSecrets: string[];
	/** Delivery cursor, or null if this trigger has never been armed. */
	cursor: number | null;
	lastDelivery: TriggerDeliveryView | null;
}

export interface DispatchPassResult {
	/** Triggers considered this pass. */
	armed: number;
	dispatched: number;
	failed: number;
	skipped: number;
}

/** One event `dryRun` found matching the trigger's `on:`; nothing is run (§9.4). */
export interface TriggerDryRunMatch {
	seq: number;
	type: string;
	ts: number;
	payload: unknown;
}

/** Definition changed after the approval dialog opened; the reviewed hash is the authorization, so re-review. */
export class TriggerReviewStaleError extends Error {
	constructor(
		readonly defId: string,
		readonly expectedHash: string,
		readonly currentHash: string,
	) {
		super(`${defId} changed while it was being reviewed; reopen the review`);
		this.name = "TriggerReviewStaleError";
	}
}

export interface TriggerServiceDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	log: Logger;
	projectRoot: string;
	projectName: string;
	/** `~/.local/share/mfw` (or `MFW_HOME`); injected so tests never touch the real home. */
	mfwHome: string;
	actions: TriggerActionRegistry;
	now?: () => number;
	/** Failure escalation (§9.1) via the project's `Notifier`. */
	notifier?: {
		notify(kind: string, detail: Record<string, unknown>): Promise<unknown>;
	};
	/** `on_failure: hold_dispatch` (§9.2) via `scheduler.hold`. Late-bound: `boot.ts` builds the scheduler after triggers. */
	holdDispatch?: (untilMs: number, reason: string) => Promise<void>;
}

export class TriggerService {
	private readonly arming: ArmingStore;
	/**
	 * Triggers that have had a dispatch pass in this process. First pass after
	 * boot/arming uses `catchup` (backlog while down); later passes use
	 * `concurrency` (events piled up during a dispatch).
	 */
	private readonly seen = new Set<string>();

	constructor(private readonly deps: TriggerServiceDeps) {
		this.arming = ArmingStore.at(deps.mfwHome, deps.projectName);
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private dir(): string {
		return join(this.deps.projectRoot, ".mfw", "triggers");
	}

	// Loading + arming reconciliation

	/**
	 * Read definitions, compare against arming records, disarm any whose pin no
	 * longer holds. Runs on every list and at the top of every dispatch pass so
	 * a fresh edit never gets one more execution.
	 */
	async reconcile(): Promise<{
		defs: TriggerDef[];
		quarantined: QuarantinedDefinition[];
		armed: TriggerDef[];
		views: TriggerView[];
	}> {
		const { defs, quarantined } = await loadTriggerDefs(
			this.dir(),
			this.deps.log,
		);
		const records = await this.arming.load();
		const byId = new Map(defs.map((d) => [d.id, d]));
		const views: TriggerView[] = [];
		const armed: TriggerDef[] = [];

		for (const def of defs) {
			const record = records[def.id];
			let state: TriggerState;
			let reason: string | undefined;
			const granted = record?.secrets ?? [];
			const missing = def.secrets.filter((s) => !granted.includes(s));

			if (!record) {
				state = "unarmed";
				reason = "present, not armed, nothing will fire until it is armed";
			} else if (record.hash !== def.hash) {
				await this.raiseDrift(def.id, "hash-drift", record.hash, def.hash);
				state = "drifted";
				reason =
					"the definition changed after it was armed, so it disarmed itself " +
					"(review the diff and arm it again)";
			} else if (record.disarmed) {
				state = "drifted";
				reason = `disarmed automatically: ${record.disarmed.reason}`;
			} else if (!def.enabled) {
				state = "disabled";
				reason = "`enabled: false` in the definition";
			} else if (missing.length > 0) {
				state = "needs-secrets";
				reason = `requests ${missing.join(", ")}, which the arming record does not grant`;
			} else {
				state = "armed";
				armed.push(def);
			}
			if (record?.hash === def.hash && record.definition === undefined) {
				await this.arming.rememberDefinition(def.id, def.definition);
				record.definition = def.definition;
			}

			views.push({
				id: def.id,
				title: def.title,
				file: def.file,
				state,
				reason,
				on: describeSource(def),
				action: def.action.kind,
				enabled: def.enabled,
				hash: def.hash,
				definition: def.definition,
				approvedDefinition: record?.definition,
				armedHash: record?.hash,
				armedAt: record?.armedAt,
				armedBy: record?.armedBy,
				requestedSecrets: def.secrets,
				grantedSecrets: granted,
				missingSecrets: missing,
				cursor: null,
				lastDelivery: null,
			});
		}

		for (const q of quarantined) {
			const id = q.id ?? q.file.replace(/\.md$/, "");
			// An armed but quarantined file has an unverifiable pin, same risk as drift.
			if (records[id]) {
				await this.raiseDrift(id, "unloadable", records[id]?.hash ?? "");
			}
			views.push({
				id,
				title: id,
				file: q.file,
				state: "quarantined",
				reason: q.reason,
				enabled: false,
				requestedSecrets: [],
				grantedSecrets: records[id]?.secrets ?? [],
				missingSecrets: [],
				cursor: null,
				lastDelivery: null,
			});
		}

		for (const [id, record] of Object.entries(records)) {
			if (byId.has(id) || views.some((v) => v.id === id)) continue;
			await this.raiseDrift(id, "definition-removed", record.hash);
			views.push({
				id,
				title: id,
				file: null,
				state: "orphaned",
				reason:
					"armed here, but there is no definition file, the arming record " +
					"outlived the trigger",
				enabled: false,
				armedHash: record.hash,
				armedAt: record.armedAt,
				armedBy: record.armedBy,
				requestedSecrets: [],
				grantedSecrets: record.secrets,
				missingSecrets: [],
				cursor: null,
				lastDelivery: null,
			});
		}

		views.sort((a, b) => a.id.localeCompare(b.id));
		return { defs, quarantined, armed, views };
	}

	/** Stamp the arming record and emit once per distinct drift. */
	private async raiseDrift(
		defId: string,
		reason: "hash-drift" | "definition-removed" | "unloadable",
		armedHash: string,
		foundHash?: string,
	): Promise<void> {
		const { changed } = await this.arming.autoDisarm(defId, reason, foundHash);
		if (!changed) return;
		this.deps.log.warn(
			{ defId, reason, armedHash, foundHash },
			"trigger disarmed itself",
		);
		const stored = await this.deps.handle.withTx(async (tx) =>
			appendEvent(tx, {
				type: "trigger.disarmed",
				payload: { defId, reason, armedHash, foundHash },
			}),
		);
		this.deps.bus.publish([stored]);
	}

	/** Views with cursor and last delivery attached. */
	async list(): Promise<TriggerView[]> {
		const { views } = await this.reconcile();
		const cursors = new Map(
			(await this.deps.handle.db.select().from(triggerCursor)).map((c) => [
				c.defId,
				c.lastSeq,
			]),
		);
		for (const view of views) {
			const raw = cursors.get(view.id);
			// `CRON_NEVER_FIRED` is a storage sentinel (`ensureCursor`); surface it as null.
			view.cursor = raw === undefined || raw === CRON_NEVER_FIRED ? null : raw;
			view.lastDelivery = await this.lastDelivery(view.id);
		}
		return views;
	}

	/** Disarm stamps for the inbox: one small JSON read, no definition scan. */
	async disarmed(): Promise<
		{ defId: string; at: number; reason: string; armedBy: string }[]
	> {
		const records = await this.arming.load();
		return Object.entries(records)
			.filter(([, r]) => r.disarmed !== undefined)
			.map(([defId, r]) => ({
				defId,
				at: r.disarmed?.at ?? r.armedAt,
				reason: r.disarmed?.reason ?? "unknown",
				armedBy: r.armedBy,
			}));
	}

	// Operator actions

	/**
	 * Arm a definition: pin its hash, grant its secrets, start the cursor at HEAD
	 * (arming must not replay history). An existing cursor is kept, so
	 * disarm + re-arm resumes.
	 */
	async arm(
		defId: string,
		opts: { by?: string; secrets?: string[]; expectedHash?: string } = {},
	): Promise<TriggerView> {
		const { defs } = await this.reconcile();
		const def = defs.find((d) => d.id === defId);
		if (!def) {
			throw new NotFoundError(
				`no loadable trigger definition '${defId}' in .mfw/triggers/`,
			);
		}
		if (opts.expectedHash && opts.expectedHash !== def.hash) {
			throw new TriggerReviewStaleError(defId, opts.expectedHash, def.hash);
		}
		await this.ensureCursor(def);
		await this.arming.arm(defId, def.hash, {
			by: opts.by,
			secrets: opts.secrets,
			definition: def.definition,
		});
		this.seen.delete(defId); // next pass is a first pass
		const views = await this.list();
		const view = views.find((v) => v.id === defId);
		if (!view) throw new Error(`trigger '${defId}' vanished while arming`);
		return view;
	}

	async disarm(defId: string): Promise<void> {
		await this.arming.disarm(defId);
	}

	/**
	 * Dry run (§9.4): evaluate the matcher against the last `limit` events (not
	 * the last `limit` matches). Nothing executes; the cursor never moves.
	 *
	 * `on:` triggers only. A `cron:` trigger is refused rather than answered
	 * with an empty list, which would read as "matches nothing".
	 */
	async dryRun(
		defId: string,
		limit = DRY_RUN_WINDOW,
	): Promise<TriggerDryRunMatch[]> {
		const { defs } = await this.reconcile();
		const def = defs.find((d) => d.id === defId);
		if (!def) {
			throw new NotFoundError(
				`no loadable trigger definition '${defId}' in .mfw/triggers/`,
			);
		}
		if (def.source.kind !== "event") {
			throw new NotFoundError(
				`trigger '${defId}' fires from a schedule, not an event, ` +
					"there is nothing to dry-run against the event log",
			);
		}
		const matcher = def.source.match;
		const { events } = await listEvents(this.deps.handle.db, { limit });
		return events
			.filter((e) => matchesEvent(matcher, e))
			.map((e) => ({ seq: e.seq, type: e.type, ts: e.ts, payload: e.payload }));
	}

	/**
	 * Operator redelivery (§9.4): re-runs the action for one recorded delivery,
	 * reusing its id so an idempotent action is a no-op. Never touches the
	 * cursor (already past this event, §6.1) and does not require the trigger
	 * to be armed.
	 */
	async retry(deliveryId: string): Promise<TriggerDeliveryView> {
		const [existing] = await this.deps.handle.db
			.select()
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.id, deliveryId));
		if (!existing) {
			throw new NotFoundError(`no delivery '${deliveryId}'`);
		}
		const { defs } = await this.reconcile();
		const def = defs.find((d) => d.id === existing.defId);
		if (!def) {
			throw new NotFoundError(
				`trigger '${existing.defId}' has no loadable definition to retry with`,
			);
		}
		const [event] = await eventsSince(
			this.deps.handle.db,
			existing.eventSeq - 1,
			1,
		);
		if (!event || event.seq !== existing.eventSeq) {
			throw new NotFoundError(
				`event ${existing.eventSeq} for delivery '${deliveryId}' is no longer in the log`,
			);
		}
		await this.deliver(def, event, existing.skippedSeqs, { force: true });
		const [row] = await this.deps.handle.db
			.select()
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.id, deliveryId));
		if (!row)
			throw new Error(`delivery '${deliveryId}' vanished while retrying`);
		return toDeliveryView(row);
	}

	/**
	 * Head, not zero (see `arm`). Returns the cursor value in force.
	 *
	 * `on:` uses the event log's `latestSeq()`. `cron:` has no log, so it stores
	 * `CRON_NEVER_FIRED` (cronDue skips catch-up while `lastFired === null`); an
	 * arm-time timestamp would suppress a firing on the arming minute. See
	 * `cron-source.ts`.
	 */
	private async ensureCursor(def: TriggerDef): Promise<number> {
		const [row] = await this.deps.handle.db
			.select()
			.from(triggerCursor)
			.where(eq(triggerCursor.defId, def.id));
		if (row) return row.lastSeq;
		const head =
			def.source.kind === "cron"
				? CRON_NEVER_FIRED
				: await latestSeq(this.deps.handle.db);
		await this.deps.handle.db
			.insert(triggerCursor)
			.values({ defId: def.id, lastSeq: head, updatedAt: new Date(this.now()) })
			.onConflictDoNothing();
		return head;
	}

	private async advanceCursor(defId: string, seq: number): Promise<void> {
		await this.deps.handle.db
			.update(triggerCursor)
			.set({ lastSeq: seq, updatedAt: new Date(this.now()) })
			.where(eq(triggerCursor.defId, defId));
	}

	async deliveries(defId: string, limit = 50): Promise<TriggerDeliveryView[]> {
		const rows = await this.deps.handle.db
			.select()
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.defId, defId))
			.orderBy(desc(triggerDeliveries.eventSeq))
			.limit(limit);
		return rows.map(toDeliveryView);
	}

	private async lastDelivery(
		defId: string,
	): Promise<TriggerDeliveryView | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.defId, defId))
			.orderBy(desc(triggerDeliveries.startedAt))
			.limit(1);
		return row ? toDeliveryView(row) : null;
	}

	// The dispatch pass

	/**
	 * One pass over every armed trigger, from the supervisor loop. Triggers run
	 * in parallel with each other and serially within themselves (the cursor
	 * blocks event N+1 until N is terminal).
	 */
	async dispatch(): Promise<DispatchPassResult> {
		const { armed } = await this.reconcile();
		const result: DispatchPassResult = {
			armed: armed.length,
			dispatched: 0,
			failed: 0,
			skipped: 0,
		};
		const settled = await Promise.allSettled(
			armed.map((def) => this.dispatchOne(def)),
		);
		for (const [i, outcome] of settled.entries()) {
			if (outcome.status === "fulfilled") {
				result.dispatched += outcome.value.dispatched;
				result.failed += outcome.value.failed;
				result.skipped += outcome.value.skipped;
			} else {
				result.failed++;
				this.deps.log.error(
					{ err: outcome.reason, defId: armed[i]?.id },
					"trigger dispatch pass failed",
				);
			}
		}
		return result;
	}

	/** One pass, one trigger. `cron:` is a due-check, handled by `dispatchCron`. */
	private async dispatchOne(
		def: TriggerDef,
	): Promise<{ dispatched: number; failed: number; skipped: number }> {
		return def.source.kind === "cron"
			? this.dispatchCron(def)
			: this.dispatchEvent(def);
	}

	private async dispatchEvent(
		def: TriggerDef,
	): Promise<{ dispatched: number; failed: number; skipped: number }> {
		const out = { dispatched: 0, failed: 0, skipped: 0 };
		const firstPass = !this.seen.has(def.id);
		// Marked caught up unless the backlog exceeds one pass (see `degraded`).
		// Staying in catch-up mode avoids one coalesced dispatch followed by
		// many individual ones from switching to `concurrency` mid-drain.
		this.seen.add(def.id);

		// `ensureCursor` creates a missing row at HEAD, so a hand-armed trigger cannot replay history.
		const cursorBefore = await this.ensureCursor(def);

		const policy = firstPass
			? def.catchup
			: concurrencyAsCatchup(def.concurrency);
		const wantsAll = policy === "all";
		const scan = await this.collectMatches(def, cursorBefore, wantsAll);
		if (scan.matches.length === 0) {
			// Nothing matched but the window was non-empty: advance past it, or the same rows rescan every pass.
			if (scan.scannedTo > cursorBefore) {
				await this.advanceCursor(def.id, scan.scannedTo);
			}
			return out;
		}

		// A retry in progress pins the cursor to its event (§7.2). Resolve it alone
		// before `select()`, or a newer match under `latest` would supersede an unfinished event.
		const oldest = scan.matches[0] as StoredEvent;
		if (await this.isPendingRetry(def.id, oldest.seq)) {
			const result = await this.deliver(def, oldest, []);
			if (result.attempted) {
				if (result.ok) out.dispatched++;
				else out.failed++;
			}
			if (!result.terminal) return out; // cooling down or retry pending
			await this.advanceCursor(def.id, oldest.seq);
			return out; // anything queued behind waits for the next pass
		}

		const { selected, skipped, degraded } = select(policy, scan.matches);
		if (degraded) {
			this.seen.delete(def.id);
			this.deps.log.warn(
				{ defId: def.id, pending: scan.matches.length, cap: MAX_CATCHUP_ALL },
				"`catchup: all` exceeded its cap, coalescing to the newest match",
			);
		}

		if (selected.length === 0) {
			// `catchup: none` / `concurrency: drop`: cursor jumps; dropped events are named in a delivery record.
			const last = scan.matches[scan.matches.length - 1] as StoredEvent;
			await this.recordSkipped(def, last, skipped);
			await this.advanceCursor(def.id, Math.max(scan.scannedTo, last.seq));
			out.skipped += skipped.length;
			return out;
		}

		let stalled = false;
		for (const [i, event] of selected.entries()) {
			// Only the final selected event carries the coalesced seqs.
			const coalesced = i === selected.length - 1 ? skipped : [];
			const result = await this.deliver(def, event, coalesced);
			if (result.attempted) {
				if (result.ok) out.dispatched++;
				else out.failed++;
				out.skipped += coalesced.length;
			}
			if (!result.terminal) {
				// Retry attempt used or still cooling down: leave the cursor behind it; the rest waits for the next pass.
				stalled = true;
				break;
			}
			// Advance after, never before: a crash repeats the action instead of skipping it.
			await this.advanceCursor(def.id, event.seq);
		}
		if (!stalled) {
			const lastSelected = selected[selected.length - 1] as StoredEvent;
			if (scan.scannedTo > lastSelected.seq) {
				await this.advanceCursor(def.id, scan.scannedTo);
			}
		}
		return out;
	}

	/**
	 * `cron:` sources: a due-check, not a scan-and-select. Goes through the same
	 * `deliver()` via a synthetic `cronTickEvent`, so retry/backoff/`on_failure`
	 * apply unchanged (see `TriggerEvent` in `actions.ts`).
	 */
	private async dispatchCron(
		def: TriggerDef,
	): Promise<{ dispatched: number; failed: number; skipped: number }> {
		const out = { dispatched: 0, failed: 0, skipped: 0 };
		if (def.source.kind !== "cron") {
			throw new Error(`dispatchCron called on non-cron trigger '${def.id}'`);
		}
		const schedule = def.source.schedule;

		// A retry in progress pins to the same firing (§7.2), found via the latest
		// delivery. `ensureCursor` is skipped: a pending retry means it already ran.
		const last = await this.lastDelivery(def.id);
		if (last?.state === "failed") {
			const event = cronTickEvent(def.id, last.eventSeq, schedule);
			const result = await this.deliver(def, event, []);
			if (result.attempted) {
				if (result.ok) out.dispatched++;
				else out.failed++;
			}
			if (result.terminal) await this.advanceCursor(def.id, last.eventSeq);
			return out;
		}

		const cursorValue = await this.ensureCursor(def);
		const lastFired = cronCursorToLastFired(cursorValue);
		const at = new Date(this.now());
		const due = cronDue(schedule, at, lastFired);
		if (due === "not-due") return out;

		if (due === "caught-up" && def.catchup === "none") {
			// §6.3: a delivery row records what was skipped, as in the event path.
			const skipEvent = cronTickEvent(def.id, at.getTime(), schedule);
			await this.recordSkipped(def, skipEvent, []);
			await this.advanceCursor(def.id, at.getTime());
			out.skipped++;
			return out;
		}

		const firedAt = at.getTime();
		const event = cronTickEvent(def.id, firedAt, schedule);
		const result = await this.deliver(def, event, []);
		if (result.attempted) {
			if (result.ok) out.dispatched++;
			else out.failed++;
		}
		if (result.terminal) await this.advanceCursor(def.id, firedAt);
		return out;
	}

	/** True if the event has a non-terminal failed delivery (retry in progress). */
	private async isPendingRetry(defId: string, seq: number): Promise<boolean> {
		const [row] = await this.deps.handle.db
			.select({ state: triggerDeliveries.state })
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.id, deliveryIdFor(defId, seq)));
		return row?.state === "failed";
	}

	/** Matching events after `since`. Drains all windows: coalescing needs the whole backlog to find the newest. */
	private async collectMatches(
		def: TriggerDef,
		since: number,
		stopAtCap: boolean,
	): Promise<{ matches: StoredEvent[]; scannedTo: number }> {
		if (def.source.kind !== "event") {
			throw new Error(`collectMatches called on non-event trigger '${def.id}'`);
		}
		const match = def.source.match;
		const matches: StoredEvent[] = [];
		let cursor = since;
		for (let window = 0; window < MAX_SCAN_WINDOWS; window++) {
			const rows = await eventsSince(this.deps.handle.db, cursor, SCAN_WINDOW);
			if (rows.length === 0) break;
			for (const row of rows) {
				if (matchesEvent(match, row)) matches.push(row);
			}
			cursor = (rows[rows.length - 1] as StoredEvent).seq;
			if (rows.length < SCAN_WINDOW) break;
			if (stopAtCap && matches.length >= MAX_CATCHUP_ALL) break;
		}
		return { matches, scannedTo: cursor };
	}

	/**
	 * Run the action and journal the attempt.
	 *
	 * `terminal: false`: the cursor must not move yet (cooling down, or failed
	 * with retry budget left). `terminal: true`: succeeded, failed with
	 * `retries: 0`, or exhausted a configured budget ("dead", §9.3).
	 * `attempted: false` is the backoff case only: nothing ran, so per-pass
	 * counters must not move.
	 *
	 * Retries are never forced above `def.retries`: trigger actions have side
	 * effects (deploy, POST) and may not be safe to repeat.
	 */
	private async deliver(
		def: TriggerDef,
		event: TriggerEvent,
		skippedSeqs: number[],
		opts: { force?: boolean } = {},
	): Promise<{ ok: boolean; terminal: boolean; attempted: boolean }> {
		const deliveryId = deliveryIdFor(def.id, event.seq);
		const [existing] = await this.deps.handle.db
			.select()
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.id, deliveryId));

		// `force` (human Retry) skips the cooldown; the automatic pass never sets it.
		if (!opts.force && existing?.state === "failed") {
			const readyAt =
				(existing.finishedAt?.getTime() ?? 0) + backoffMs(existing.attempt);
			if (this.now() < readyAt) {
				return { ok: false, terminal: false, attempted: false };
			}
		}

		const startedAt = this.now();
		const records = await this.arming.load();
		const granted = records[def.id]?.secrets ?? [];
		const attemptNumber = existing ? existing.attempt + 1 : 1;

		await this.deps.handle.db
			.insert(triggerDeliveries)
			.values({
				id: deliveryId,
				defId: def.id,
				eventSeq: event.seq,
				eventType: event.type,
				state: "running",
				attempt: 1,
				startedAt: new Date(startedAt),
				skippedSeqs,
			})
			.onConflictDoUpdate({
				target: triggerDeliveries.id,
				// A replay reuses the id, so the row counts attempts.
				set: {
					state: "running",
					attempt: sql`${triggerDeliveries.attempt} + 1`,
					startedAt: new Date(startedAt),
					finishedAt: null,
					skippedSeqs,
				},
			});

		const dispatch: TriggerDispatch = {
			def,
			deliveryId,
			event,
			projectRoot: this.deps.projectRoot,
			projectName: this.deps.projectName,
			grantedSecrets: granted,
			skippedSeqs,
		};

		let result: {
			ok: boolean;
			detail?: string;
			exitCode?: number;
			runId?: string;
		};
		try {
			result = await this.deps.actions.run(dispatch);
		} catch (e) {
			result = {
				ok: false,
				detail: e instanceof Error ? e.message : String(e),
			};
		}

		const finishedAt = this.now();
		// A permanently failing trigger must not pin its cursor; `exhausted` marks the event done either way.
		const exhausted = attemptNumber > def.retries;
		const terminal = result.ok || exhausted;
		const state = result.ok
			? "ok"
			: !terminal
				? "failed" // retry pending, the SAME event will be re-attempted
				: def.retries > 0
					? "dead" // a configured retry budget ran out
					: "failed"; // no retry configured

		await this.deps.handle.db
			.update(triggerDeliveries)
			.set({
				state,
				finishedAt: new Date(finishedAt),
				durationMs: finishedAt - startedAt,
				detail: result.detail ?? null,
				exitCode: result.exitCode ?? null,
				runId: result.runId ?? null,
			})
			.where(eq(triggerDeliveries.id, deliveryId));

		if (result.ok) await this.arming.clearFailing(def.id);

		const stored = await this.deps.handle.withTx(async (tx) =>
			result.ok
				? appendEvent(tx, {
						type: "trigger.dispatched",
						payload: {
							defId: def.id,
							deliveryId,
							eventSeq: event.seq,
							eventType: event.type,
							action: def.action.kind,
							skippedSeqs: skippedSeqs.length > 0 ? skippedSeqs : undefined,
						},
					})
				: appendEvent(tx, {
						type: "trigger.failed",
						payload: {
							defId: def.id,
							deliveryId,
							eventSeq: event.seq,
							eventType: event.type,
							action: def.action.kind,
							detail: result.detail ?? "the action reported failure",
						},
					}),
		);
		this.deps.bus.publish([stored]);

		if (!result.ok && terminal) {
			await this.surfaceFailure(
				def,
				result.detail ?? "the action reported failure",
			);
		}

		return { ok: result.ok, terminal, attempted: true };
	}

	/** Terminal failure (§9.1, §9.2): stamp for the inbox, notify, and hold dispatch only if opted in. */
	private async surfaceFailure(def: TriggerDef, detail: string): Promise<void> {
		if (def.onFailure === "ignore") return; // fire-and-forget, by request
		const holdDispatch = def.onFailure === "hold_dispatch";
		await this.arming.markFailing(def.id, detail, holdDispatch);
		await this.deps.notifier?.notify("trigger_failed", {
			project: this.deps.projectName,
			message: `trigger "${def.id}" failed: ${detail}`,
		});
		if (holdDispatch) {
			await this.deps.holdDispatch?.(
				this.now() + HOLD_DISPATCH_MS,
				`trigger "${def.id}" failed: ${detail}`,
			);
		}
	}

	/** Triggers whose last delivery died, for the inbox; cheap like `disarmed()` (one JSON file). */
	async failing(): Promise<
		{ defId: string; at: number; detail: string; holdDispatch: boolean }[]
	> {
		const records = await this.arming.load();
		return Object.entries(records)
			.filter(([, r]) => r.failing !== undefined)
			.map(([defId, r]) => ({
				defId,
				at: r.failing?.at ?? r.armedAt,
				detail: r.failing?.detail ?? "unknown",
				holdDispatch: r.failing?.holdDispatch ?? false,
			}));
	}

	private async recordSkipped(
		def: TriggerDef,
		event: TriggerEvent,
		skippedSeqs: number[],
	): Promise<void> {
		const at = this.now();
		await this.deps.handle.db
			.insert(triggerDeliveries)
			.values({
				id: deliveryIdFor(def.id, event.seq),
				defId: def.id,
				eventSeq: event.seq,
				eventType: event.type,
				state: "skipped",
				attempt: 0,
				startedAt: new Date(at),
				finishedAt: new Date(at),
				durationMs: 0,
				detail: `dropped by ${def.catchup === "none" ? "catchup: none" : "concurrency: drop"}`,
				skippedSeqs,
			})
			.onConflictDoNothing();
	}
}

// ---------------------------------------------------------------------------

/** `concurrency` and `catchup` are the same coalescing question asked about two
 *  different situations, so they reduce to one selection policy. */
function concurrencyAsCatchup(c: "serial" | "latest" | "drop") {
	return c === "serial" ? "all" : c === "latest" ? "latest" : "none";
}

export function select(
	policy: "latest" | "all" | "none",
	matches: StoredEvent[],
): { selected: StoredEvent[]; skipped: number[]; degraded: boolean } {
	if (matches.length === 0)
		return { selected: [], skipped: [], degraded: false };
	if (policy === "none") {
		return {
			selected: [],
			skipped: matches.map((m) => m.seq),
			degraded: false,
		};
	}
	if (policy === "all" && matches.length <= MAX_CATCHUP_ALL) {
		return { selected: matches, skipped: [], degraded: false };
	}
	// `latest`, or `all` past its cap: dispatch the newest and NAME the rest.
	const last = matches[matches.length - 1] as StoredEvent;
	return {
		selected: [last],
		skipped: matches.slice(0, -1).map((m) => m.seq),
		degraded: policy === "all",
	};
}

export function deliveryIdFor(defId: string, seq: number): string {
	return createHash("sha256")
		.update(`${defId}:${seq}`, "utf8")
		.digest("hex")
		.slice(0, 16);
}

function describeSource(def: TriggerDef): string {
	if (def.source.kind === "cron") return `cron: ${def.source.schedule}`;
	const m = def.source.match;
	if (m.kind === "prefix") return `${m.prefix}.*`;
	if (m.kind === "exact") return m.type;
	const where = Object.entries(m.where)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
	return `${m.type} where ${where}`;
}

function toDeliveryView(row: {
	id: string;
	eventSeq: number;
	eventType: string;
	state: string;
	attempt: number;
	startedAt: Date;
	finishedAt: Date | null;
	durationMs: number | null;
	detail: string | null;
	runId: string | null;
	skippedSeqs: number[];
}): TriggerDeliveryView {
	return {
		id: row.id,
		eventSeq: row.eventSeq,
		eventType: row.eventType,
		state: row.state,
		attempt: row.attempt,
		startedAt: row.startedAt.getTime(),
		finishedAt: row.finishedAt?.getTime() ?? null,
		durationMs: row.durationMs,
		detail: row.detail,
		runId: row.runId,
		skippedSeqs: row.skippedSeqs,
	};
}
