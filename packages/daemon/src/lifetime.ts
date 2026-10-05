import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { LIFETIME_ID_RE } from "@mfw/db/ids";
import { lifetimeState } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { DefinitionLoader, type DefinitionSource } from "./definitions.ts";
import type { Logger } from "./log.ts";
import type { TaskService } from "./task-service.ts";
import { cronDue } from "./triggers/cron-source.ts";

/**
 * Lifetime (recurring) tasks. Firing state is durable (`lifetime_state`, one
 * row per definition), so a definition due while the daemon was down catches
 * up on the next tick. A fired definition creates a normal `backlog` task
 * rather than running inline.
 *
 * Definition loading is shared via `DefinitionLoader` and the schedule
 * due-check via `cronDue` (`triggers/cron-source.ts`). Lifetime keeps its own
 * table and `lifetime.fired` event (itself a triggerable event) instead of
 * `trigger_cursor` / `trigger_deliveries`, which require arming.
 */

export interface LifetimeDef {
	id: string;
	title: string;
	type: "implementation" | "spike" | "epic" | "maintenance";
	trigger: { schedule?: string; condition?: string };
	/** Skip firing while a task from this definition is still open. */
	dedupe: "skip_if_active" | "always";
	body: string;
	dod: unknown;
}

export interface FireResult {
	defId: string;
	taskId: string | null;
	reason: "fired" | "caught-up" | "skipped-active" | "not-due" | "invalid";
}

export class LifetimeManager {
	constructor(
		private readonly deps: {
			handle: ProjectDbHandle;
			bus: EventBus;
			tasks: TaskService;
			log: Logger;
			projectRoot: string;
			now?: () => number;
			conditions?: Record<string, (root: string) => Promise<boolean>>;
		},
	) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private dir(): string {
		return join(this.deps.projectRoot, ".mfw", "lifetime");
	}

	/** Load definitions from disk. A malformed file is quarantined and skipped (see `DefinitionLoader`). */
	async load(): Promise<LifetimeDef[]> {
		const loader = new DefinitionLoader<LifetimeDef>({
			dir: this.dir(),
			idRe: LIFETIME_ID_RE,
			kind: "lifetime",
			log: this.deps.log,
			parse: (src) => this.parse(src),
		});
		return (await loader.load()).defs;
	}

	private parse(src: DefinitionSource): LifetimeDef {
		const { fm, id, body } = src;
		const trigger = (fm.trigger ?? {}) as Record<string, unknown>;
		const condition = trigger.condition ? String(trigger.condition) : undefined;
		// Reject unregistered predicates (they would silently never fire); the message becomes the quarantine reason.
		if (condition && !this.deps.conditions?.[condition]) {
			const known = Object.keys(this.deps.conditions ?? {});
			throw new Error(
				known.length
					? `unknown lifetime condition "${condition}"; known: ${known.join(", ")}`
					: `unknown lifetime condition "${condition}"; no conditions are registered`,
			);
		}
		return {
			id,
			title: String(fm.title ?? id),
			type: (fm.type as LifetimeDef["type"]) ?? "maintenance",
			trigger: {
				schedule: trigger.schedule ? String(trigger.schedule) : undefined,
				condition,
			},
			dedupe: fm.dedupe === "always" ? "always" : "skip_if_active",
			body,
			dod: fm.dod ?? null,
		};
	}

	/** Fire every due definition. Missed occurrences catch up once, not once per missed minute. */
	async tick(at = new Date(this.now())): Promise<FireResult[]> {
		const results: FireResult[] = [];
		for (const def of await this.load()) {
			try {
				results.push(await this.fireIfDue(def, at));
			} catch (e) {
				this.deps.log.error({ err: e, defId: def.id }, "lifetime fire failed");
				results.push({ defId: def.id, taskId: null, reason: "invalid" });
			}
		}
		return results;
	}

	private async fireIfDue(def: LifetimeDef, at: Date): Promise<FireResult> {
		const [state] = await this.deps.handle.db
			.select()
			.from(lifetimeState)
			.where(eq(lifetimeState.defId, def.id));
		const lastFired = state?.lastFiredAt?.getTime() ?? null;

		const due = await this.isDue(def, at, lastFired);
		if (due === "not-due")
			return { defId: def.id, taskId: null, reason: "not-due" };

		if (def.dedupe === "skip_if_active" && (await this.hasOpenTask(def.id))) {
			return { defId: def.id, taskId: null, reason: "skipped-active" };
		}

		const task = await this.deps.tasks.create({
			title: def.title,
			body: def.body,
			type: def.type,
			source: "lifetime",
			lifetimeDefId: def.id,
			dod: (def.dod ?? null) as never,
		});

		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.insert(lifetimeState)
				.values({
					defId: def.id,
					lastFiredAt: at,
					lastTaskId: task.id,
					lastError: null,
				})
				.onConflictDoUpdate({
					target: lifetimeState.defId,
					set: { lastFiredAt: at, lastTaskId: task.id, lastError: null },
				});
			return appendEvent(tx, {
				type: "lifetime.fired",
				payload: { defId: def.id, taskId: task.id },
			});
		});
		this.deps.bus.publish([stored]);
		return { defId: def.id, taskId: task.id, reason: due };
	}

	private async isDue(
		def: LifetimeDef,
		at: Date,
		lastFired: number | null,
	): Promise<"fired" | "caught-up" | "not-due"> {
		if (def.trigger.condition) {
			const predicate = this.deps.conditions?.[def.trigger.condition];
			if (!predicate) return "not-due";
			// Conditions are level-triggered; the dedupe rule stops re-firing.
			return (await predicate(this.deps.projectRoot)) ? "fired" : "not-due";
		}
		if (!def.trigger.schedule) return "not-due";
		return cronDue(def.trigger.schedule, at, lastFired);
	}

	private async hasOpenTask(defId: string): Promise<boolean> {
		const open = await this.deps.tasks.list();
		return open.some(
			(t) =>
				t.lifetimeDefId === defId && !["done", "archived"].includes(t.status),
		);
	}
}
