import { mkdir, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import type { WakeClass } from "@mfw/core/events";
import type { ProjectDbHandle } from "@mfw/db/client";
import {
	appendEvent,
	type EventBus,
	latestSeq,
	type StoredEvent,
} from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	type BrainTurnStatus,
	brainActions,
	brainSessions,
	brainTurns,
	clarifications,
	decisions,
	events,
	type RunReasoningEffort,
	runs,
	sessions,
} from "@mfw/db/schema";
import { recordBrainUsage, spendTotals } from "@mfw/db/spend";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lte,
	ne,
	or,
} from "drizzle-orm";
import { mcpMainScript } from "../agents/adapter.ts";
import { parseAgentEvents } from "../agents/events.ts";
import { nativeSessionUuid } from "../agents/native-session.ts";
import type { StoredBrainConfig } from "../config.ts";
import { HumanOverrideService } from "../human-override.ts";
import type { Logger } from "../log.ts";
import type { ProviderHold, RoutingDecision } from "../routing.ts";
import type { RunRegistry, RunRow } from "../run-registry.ts";
import type { TaskService } from "../task-service.ts";
import { BrainActionService } from "./actions.ts";
import { pruneAwaiting } from "./awaiting.ts";
import {
	type DigestInput,
	type DigestRunFact,
	renderDigest,
} from "./digest.ts";
import { BrainActionExecutor, type BrainExecutorDeps } from "./executor.ts";
import { BrainReadService, type BrainWorld } from "./reads.ts";
import type { BrainMcpServer, BrainTurnLaunch } from "./turn-run.ts";
import {
	classifyEvent,
	dueWake,
	pendingWakes,
	WAKE_EVENT_TYPES,
	type WakeEvent,
} from "./wake-table.ts";

/**
 * The project brain's runtime. One brain per project: a
 * long-lived native session woken by `BrainWaker` logic below, each wake a
 * `kind: brain` run in tmux. Everything it needs survives losing the session:
 * the cursor, turns, actions and decisions are rows, and a rollover rebuilds
 * the brain's context from them.
 *
 * Off unless the project configures `brain.routes`; a project without one
 * cannot dispatch (there is no headless pipeline to fall back to). The brain
 * decides what runs through its act tools, executed by `BrainActionExecutor`.
 */

export const BRAIN_DEFAULTS = {
	heartbeatMin: 30,
	/** 60% of a 200k window. */
	rolloverTokens: 120_000,
	turnTimeoutMs: 10 * 60_000,
	maxTurnsPerHour: 12,
	maxTurnsPerDay: 150,
	/** Consecutive failed turns that open the circuit. */
	failureLimit: 3,
	/** First wake after this local hour starts a fresh generation. */
	dailyRolloverHour: 4,
	/** Retry backoff after a failed turn: base, doubling, capped. */
	retryBaseMs: 30_000,
	retryMaxMs: 10 * 60_000,
} as const;

export interface BrainConfig {
	routes: {
		provider: string;
		model?: string;
		effort?: RunReasoningEffort;
	}[];
	heartbeatMin: number;
	rolloverTokens: number;
	turnTimeoutMs: number;
	maxTurnsPerHour: number;
	maxTurnsPerDay: number;
	failureLimit: number;
}

/** The effective brain config, or null (brain off) when no route is configured. */
export function resolveBrainConfig(
	stored: StoredBrainConfig | null | undefined,
): BrainConfig | null {
	if (!stored || stored.routes.length === 0) return null;
	return {
		routes: stored.routes.map((r) => ({
			provider: r.provider,
			...(r.model ? { model: r.model } : {}),
			...(r.effort ? { effort: r.effort } : {}),
		})),
		heartbeatMin: stored.heartbeatMin ?? BRAIN_DEFAULTS.heartbeatMin,
		rolloverTokens: stored.rolloverTokens ?? BRAIN_DEFAULTS.rolloverTokens,
		turnTimeoutMs: stored.turnTimeoutMs ?? BRAIN_DEFAULTS.turnTimeoutMs,
		maxTurnsPerHour: stored.maxTurnsPerHour ?? BRAIN_DEFAULTS.maxTurnsPerHour,
		maxTurnsPerDay: stored.maxTurnsPerDay ?? BRAIN_DEFAULTS.maxTurnsPerDay,
		failureLimit: BRAIN_DEFAULTS.failureLimit,
	};
}

/** What the runtime needs of RunEngine. */
export interface BrainLauncher {
	routeBrain(target: {
		provider: string;
		model?: string;
		effort?: RunReasoningEffort;
	}): Promise<{
		route: RoutingDecision;
		held: (ProviderHold & { key: string }) | null;
	}>;
	startBrainTurn(opts: {
		runId: string;
		route: RoutingDecision;
		prompt: string;
		scratchDir: string;
		launch: BrainTurnLaunch;
	}): Promise<{ runId: string }>;
}

export interface BrainRuntimeDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	registry: RunRegistry;
	tasks: TaskService;
	engine: BrainLauncher;
	log: Logger;
	/** The project's `.mfw` directory: scratch dirs live under `brain/`. */
	mfwDir: string;
	projectName: string;
	bootId: string;
	/** Live config; null = brain off. Read every tick, so settings apply live. */
	config: () => BrainConfig | null;
	world: BrainWorld;
	hostname?: string;
	now?: () => number;
	mcp?: { url?: string; script?: string; command?: string };
	/** What the action executor needs of the daemon beyond the shared handles. */
	exec: Omit<
		BrainExecutorDeps,
		"handle" | "bus" | "tasks" | "registry" | "log" | "now"
	>;
	/** Raised once when the circuit opens. */
	notifyStuck?: (detail: {
		sessionId: string;
		failures: number;
		error: string | null;
	}) => Promise<unknown>;
	/** Local hour used by the daily rollover (test seam). */
	localHour?: (ms: number) => { dayKey: string; hour: number };
}

export type TickOutcome =
	| { state: "off" }
	| { state: "paused" | "failed" }
	| { state: "turn_live"; runId: string }
	| { state: "idle" }
	| { state: "backoff" | "capped" | "held" | "no_work" }
	| { state: "started"; runId: string; wakeClass: WakeClass };

const LIVE_RUN_STATES = ["starting", "running", "ended", "finalizing"] as const;
const TERMINAL_RUN_STATES = new Set([
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);
const RESUME_FAILURE =
	/no conversation found|session .*not found|thread .*not found|no rollout found/i;

function localClock(ms: number): { dayKey: string; hour: number } {
	const d = new Date(ms);
	return {
		dayKey: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
		hour: d.getHours(),
	};
}

export class BrainRuntime {
	readonly reads: BrainReadService;
	readonly actions: BrainActionService;
	readonly executor: BrainActionExecutor;
	/** A person's levers: override a decision, message the brain. */
	readonly human: HumanOverrideService;
	private readonly now: () => number;
	private readonly host: string;
	private inflight: Promise<TickOutcome> | null = null;
	/** Failures already announced, so a stuck brain pages once. */
	private stuckNotified = new Set<string>();

	constructor(private readonly deps: BrainRuntimeDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.host = deps.hostname ?? osHostname();
		this.reads = new BrainReadService({
			handle: deps.handle,
			tasks: deps.tasks,
			registry: deps.registry,
			world: deps.world,
			projectRoot: join(deps.mfwDir, ".."),
			log: deps.log,
			now: deps.now,
		});
		this.executor = new BrainActionExecutor({
			...deps.exec,
			handle: deps.handle,
			bus: deps.bus,
			tasks: deps.tasks,
			registry: deps.registry,
			log: deps.log,
			now: deps.now,
		});
		this.actions = new BrainActionService({
			handle: deps.handle,
			bus: deps.bus,
			tasks: deps.tasks,
			registry: deps.registry,
			reads: this.reads,
			executor: this.executor,
			world: deps.world,
			log: deps.log,
			now: deps.now,
		});
		this.human = new HumanOverrideService({
			handle: deps.handle,
			bus: deps.bus,
			tasks: deps.tasks,
			registry: deps.registry,
			engine: deps.exec.engine,
			executor: this.executor,
			log: deps.log,
			...(deps.exec.wakeScheduler
				? { wakeScheduler: deps.exec.wakeScheduler }
				: {}),
			now: deps.now,
		});
	}

	/** Attempt-group bookkeeping (see `BrainActionExecutor.settleGroups`). */
	settleGroups(): Promise<number> {
		return this.executor.settleGroups();
	}

	/** The wall clock the supervisor enforces on a live turn. */
	turnTimeoutMs(): number {
		return this.deps.config()?.turnTimeoutMs ?? BRAIN_DEFAULTS.turnTimeoutMs;
	}

	/** One pass: close finished turns, then wake the brain if something is due. Serialized. */
	tick(): Promise<TickOutcome> {
		if (this.inflight) return this.inflight;
		const p = this.tickOnce().finally(() => {
			this.inflight = null;
		});
		this.inflight = p;
		return p;
	}

	private async tickOnce(): Promise<TickOutcome> {
		// Closing a finished turn must work even when the brain was switched off.
		await this.reconcileTurns();
		const cfg = this.deps.config();
		if (!cfg) return { state: "off" };

		const first = cfg.routes[0];
		if (!first) return { state: "off" };
		let session = await this.currentSession();
		if (!session) {
			const { route } = await this.deps.engine.routeBrain(first);
			session = await this.createSession(route);
		}
		if (session.status === "failed") return { state: "failed" };
		if (session.status === "paused" || session.status === "retired") {
			return { state: "paused" };
		}
		const live = await this.liveTurn(session.id);
		if (live) {
			await this.renewLease(session.id, cfg);
			return { state: "turn_live", runId: live.runId };
		}
		if (session.status === "turn") {
			// A turn status with no live turn: a crash between the two writes.
			await this.setSession(session.id, { status: "idle" });
			session = { ...session, status: "idle" };
		}
		return this.maybeStart(session, cfg);
	}

	// -----------------------------------------------------------------------
	// session rows
	// -----------------------------------------------------------------------

	async currentSession() {
		const rows = await this.deps.handle.db
			.select()
			.from(brainSessions)
			.where(ne(brainSessions.status, "retired"))
			.orderBy(desc(brainSessions.createdAt));
		return rows.find((r) => r.scope.kind === "project") ?? null;
	}

	private async createSession(route: RoutingDecision) {
		const now = this.now();
		const head = await latestSeq(this.deps.handle.db);
		const [row] = await this.deps.handle.db
			.insert(brainSessions)
			.values({
				id: ulid(),
				scope: { kind: "project" },
				status: "idle",
				harness: route.provider,
				model: route.model,
				effort: route.effort,
				endpoint: route.endpoint?.id ?? null,
				nativeHost: this.host,
				generation: 0,
				generationStartedAt: new Date(now),
				// Enabling the brain never replays project history.
				cursor: head,
				createdAt: new Date(now),
			})
			.returning();
		if (!row) throw new Error("brain session insert returned no row");
		this.deps.log.info(
			{ sessionId: row.id, cursor: head },
			"brain session created",
		);
		return row;
	}

	private async setSession(
		id: string,
		patch: Partial<typeof brainSessions.$inferInsert>,
	) {
		await this.deps.handle.db
			.update(brainSessions)
			.set(patch)
			.where(eq(brainSessions.id, id));
	}

	private async renewLease(id: string, cfg: BrainConfig) {
		await this.setSession(id, {
			leaseOwner: this.deps.bootId,
			leaseUntil: new Date(this.now() + cfg.turnTimeoutMs + 60_000),
		});
	}

	private async liveTurn(sessionId: string) {
		const [t] = await this.deps.handle.db
			.select()
			.from(brainTurns)
			.where(
				and(
					eq(brainTurns.sessionId, sessionId),
					eq(brainTurns.status, "running"),
				),
			);
		return t ?? null;
	}

	/** Put the circuit back to closed (a person fixed the cause and pressed retry). */
	async resetCircuit(): Promise<void> {
		const s = await this.currentSession();
		if (!s) return;
		await this.setSession(s.id, {
			status: "idle",
			consecutiveFailures: 0,
			retryAfter: null,
		});
		this.stuckNotified.delete(s.id);
	}

	/** Pause or resume waking (a human hold; a budget hold uses the same state). */
	async setPaused(paused: boolean): Promise<void> {
		const s = await this.currentSession();
		if (!s || s.status === "failed") return;
		await this.setSession(s.id, { status: paused ? "paused" : "idle" });
	}

	// -----------------------------------------------------------------------
	// waking
	// -----------------------------------------------------------------------

	private async maybeStart(
		session: NonNullable<Awaited<ReturnType<BrainRuntime["currentSession"]>>>,
		cfg: BrainConfig,
	): Promise<TickOutcome> {
		const now = this.now();
		const db = this.deps.handle.db;
		if (session.retryAfter && session.retryAfter.getTime() > now) {
			return { state: "backoff" };
		}

		const head = await latestSeq(db);
		const pendingRows = await db
			.select()
			.from(events)
			.where(
				and(
					gt(events.seq, session.cursor),
					lte(events.seq, head),
					inArray(events.type, [...WAKE_EVENT_TYPES]),
				),
			)
			.orderBy(asc(events.seq))
			.limit(1000);
		const slice: WakeEvent[] = pendingRows.map((e) => ({
			seq: e.seq,
			ts: e.ts.getTime(),
			type: e.type,
			taskId: e.taskId,
			runId: e.runId,
			payload: e.payload,
		}));
		const kinds = await this.runKinds(slice);
		let wake: WakeClass | null = dueWake(
			pendingWakes(slice, (id) => kinds.get(id)),
			now,
		);

		if (!wake) {
			// Heartbeat: quiet for a long time while there is work to watch.
			const [last] = await db
				.select()
				.from(brainTurns)
				.where(eq(brainTurns.sessionId, session.id))
				.orderBy(desc(brainTurns.seq))
				.limit(1);
			const since = last
				? now - last.startedAt.getTime()
				: Number.POSITIVE_INFINITY;
			// A `sleep` the brain asked for sets how long this quiet may last.
			const hinted = (
				session.wakeHint as { wakeAfterMin?: number | null } | null
			)?.wakeAfterMin;
			const quietMin = typeof hinted === "number" ? hinted : cfg.heartbeatMin;
			if (since >= quietMin * 60_000 && (await this.hasWork())) {
				wake = "heartbeat";
			}
		}
		if (!wake) return { state: "idle" };

		// Rate caps (I9): turns per hour and per day.
		const hourAgo = new Date(now - 3_600_000);
		const dayAgo = new Date(now - 86_400_000);
		const recent = await db
			.select({ startedAt: brainTurns.startedAt })
			.from(brainTurns)
			.where(gte(brainTurns.startedAt, dayAgo));
		if (
			recent.length >= cfg.maxTurnsPerDay ||
			recent.filter((r) => r.startedAt >= hourAgo).length >= cfg.maxTurnsPerHour
		) {
			return { state: "capped" };
		}

		// Route: the first configured route whose account is not held.
		let chosen: Awaited<ReturnType<BrainLauncher["routeBrain"]>> | null = null;
		for (const r of cfg.routes) {
			const resolved = await this.deps.engine.routeBrain(r);
			if (!resolved.held) {
				chosen = resolved;
				break;
			}
		}
		if (!chosen) return { state: "held" };

		// The range ends at the last event that can wake the brain (or the head
		// when there are none), so a re-delivery after a failed turn is exactly
		// the same `events_from..events_to` unless something new arrived.
		const relevant = slice.filter(
			(e) => classifyEvent(e, (id) => kinds.get(id)) !== null,
		);
		const eventsTo = relevant[relevant.length - 1]?.seq ?? head;
		return this.startTurn(session, cfg, chosen.route, wake, eventsTo);
	}

	private async hasWork(): Promise<boolean> {
		const live = await this.deps.registry.list({
			states: [...LIVE_RUN_STATES],
		});
		if (live.some((r) => r.kind !== "brain")) return true;
		// A ready task is work only when something can start it: with dispatch
		// stopped (master stop, own stop, red main) a heartbeat would only
		// repeat the same rejected spawns at a cost.
		if ((await this.deps.world.dispatchPaused?.()) != null) return false;
		return (await this.deps.tasks.readySet()).length > 0;
	}

	private async runKinds(slice: WakeEvent[]): Promise<Map<string, string>> {
		const ids = [
			...new Set(slice.map((e) => e.runId).filter((id): id is string => !!id)),
		];
		const out = new Map<string, string>();
		if (ids.length === 0) return out;
		const rows = await this.deps.handle.db
			.select({ id: runs.id, kind: runs.kind })
			.from(runs)
			.where(inArray(runs.id, ids));
		for (const r of rows) out.set(r.id, r.kind);
		return out;
	}

	private rolloverReason(
		session: NonNullable<Awaited<ReturnType<BrainRuntime["currentSession"]>>>,
		cfg: BrainConfig,
		route: RoutingDecision,
		now: number,
	): string | null {
		// Nothing native to continue: the next turn is fresh anyway.
		if (!session.nativeSessionId) return null;
		if (session.harness !== route.provider || session.model !== route.model) {
			return "route_changed";
		}
		if (session.nativeHost !== this.host) return "host_changed";
		if (session.contextTokens > cfg.rolloverTokens) return "context_tokens";
		// Once a day, at the first wake after the configured hour.
		const clock = this.deps.localHour ?? localClock;
		const nowC = clock(now);
		const genC = clock(session.generationStartedAt.getTime());
		if (
			nowC.hour >= BRAIN_DEFAULTS.dailyRolloverHour &&
			(nowC.dayKey !== genC.dayKey ||
				genC.hour < BRAIN_DEFAULTS.dailyRolloverHour)
		) {
			return "daily";
		}
		return null;
	}

	/** A new generation: fresh native session, rehydrated from durable state. */
	async rollover(
		sessionId: string,
		reason: string,
		route: {
			provider: string;
			model: string;
			effort?: string | null;
			endpoint?: string | null;
		},
	) {
		const nowMs = this.now();
		const published: StoredEvent[] = [];
		await this.deps.handle.withTx(async (tx) => {
			const [s] = await tx
				.select()
				.from(brainSessions)
				.where(eq(brainSessions.id, sessionId));
			if (!s) throw new Error(`unknown brain session ${sessionId}`);
			await tx
				.update(brainSessions)
				.set({
					generation: s.generation + 1,
					generationStartedAt: new Date(nowMs),
					nativeSessionId: null,
					lastCostTotal: null,
					contextTokens: 0,
					nativeHost: this.host,
					harness: route.provider,
					model: route.model,
					effort: route.effort ?? null,
					endpoint: route.endpoint ?? null,
				})
				.where(eq(brainSessions.id, sessionId));
			const [d] = await tx
				.insert(decisions)
				.values({
					ts: new Date(nowMs),
					role: "brain",
					model: route.model,
					status: "ok",
					action: "rollover",
					reason,
					input: {
						from: {
							harness: s.harness,
							model: s.model,
							generation: s.generation,
							nativeSessionId: s.nativeSessionId,
						},
					},
					output: { to: { generation: s.generation + 1 } },
					finishedAt: new Date(nowMs),
					brainSessionId: sessionId,
					kind: "rollover",
					harness: route.provider,
				})
				.returning({ id: decisions.id });
			published.push(
				await appendEvent(
					tx,
					{
						type: "brain.rollover",
						payload: {
							sessionId,
							reason,
							fromGeneration: s.generation,
							toGeneration: s.generation + 1,
							fromNativeSessionId: s.nativeSessionId,
							toNativeSessionId: null,
						},
					},
					nowMs,
				),
			);
			this.deps.log.info(
				{ sessionId, reason, generation: s.generation + 1, decisionId: d?.id },
				"brain rolled over",
			);
		});
		this.deps.bus.publish(published);
		return this.currentSession();
	}

	private async startTurn(
		sessionIn: NonNullable<Awaited<ReturnType<BrainRuntime["currentSession"]>>>,
		cfg: BrainConfig,
		route: RoutingDecision,
		wakeClass: WakeClass,
		head: number,
	): Promise<TickOutcome> {
		const now = this.now();
		let session = sessionIn;
		const reason = this.rolloverReason(session, cfg, route, now);
		if (reason) {
			const next = await this.rollover(session.id, reason, {
				provider: route.provider,
				model: route.model,
				effort: route.effort,
				endpoint: route.endpoint?.id ?? null,
			});
			if (next) session = next;
		}

		const db = this.deps.handle.db;
		const runId = ulid();
		const resumeId = session.nativeSessionId;
		const resumed = !!resumeId;
		const mintsId = route.provider === "claude-cli";
		const mintedId = !resumed && mintsId ? nativeSessionUuid(runId) : null;
		const [lastTurn] = await db
			.select()
			.from(brainTurns)
			.where(eq(brainTurns.sessionId, session.id))
			.orderBy(desc(brainTurns.seq))
			.limit(1);
		const seq = (lastTurn?.seq ?? 0) + 1;
		const eventsFrom = session.cursor + 1;

		// The digest first: a turn row means a launch is intended.
		const input = await this.digestInput({
			session,
			wakeClass,
			turnSeq: seq,
			resumed,
			eventsFrom,
			eventsTo: head,
			lastTurnAt: lastTurn?.startedAt.getTime() ?? null,
			now,
			cfg,
		});
		const { markdown } = renderDigest(input);

		// Intent before effect: the turn row, the session's native id and the
		// `brain.turn_started` event commit together, before anything launches.
		const published: StoredEvent[] = [];
		await this.deps.handle.withTx(async (tx) => {
			await tx.insert(brainTurns).values({
				runId,
				sessionId: session.id,
				seq,
				generation: session.generation,
				wakeClass,
				eventsFrom,
				eventsTo: head,
				resumed,
				status: "running",
				startedAt: new Date(now),
			});
			await tx
				.update(brainSessions)
				.set({
					status: "turn",
					leaseOwner: this.deps.bootId,
					leaseUntil: new Date(now + cfg.turnTimeoutMs + 60_000),
					...(mintedId ? { nativeSessionId: mintedId } : {}),
					// The brain's `sleep` hint is delivered in this digest; it is spent.
					wakeHint: null,
					// A route with nothing to continue is simply adopted.
					harness: route.provider,
					model: route.model,
					effort: route.effort,
					endpoint: route.endpoint?.id ?? null,
				})
				.where(eq(brainSessions.id, session.id));
			published.push(
				await appendEvent(
					tx,
					{
						type: "brain.turn_started",
						runId,
						payload: {
							sessionId: session.id,
							seq,
							generation: session.generation,
							wakeClass,
							eventsFrom,
							eventsTo: head,
							resumed,
						},
					},
					now,
				),
			);
		});
		this.deps.bus.publish(published);

		try {
			const runDir = this.deps.registry.runDir(runId);
			await mkdir(runDir, { recursive: true });
			await writeFile(join(runDir, "digest.md"), markdown);
			const scratchDir = join(this.deps.mfwDir, "brain", session.id);
			await mkdir(scratchDir, { recursive: true });
			const mcp = this.mcpServer(session.id, runId);
			const mcpConfigPath = join(runDir, "mcp.json");
			await writeFile(
				mcpConfigPath,
				`${JSON.stringify({ mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: mcp.env } } }, null, "\t")}\n`,
			);
			await this.deps.engine.startBrainTurn({
				runId,
				route,
				prompt: markdown,
				scratchDir,
				launch: {
					...(resumeId ? { resumeSessionId: resumeId } : {}),
					...(mintedId ? { sessionId: mintedId } : {}),
					mcpConfigPath,
					mcp,
					projectDirName: `mfw-brain-${session.id}`,
				},
			});
		} catch (e) {
			this.deps.log.error({ err: e, runId }, "brain turn failed to start");
			await this.endTurn(runId, "failed", {
				error: `start failed: ${e instanceof Error ? e.message : String(e)}`,
			});
			return { state: "backoff" };
		}
		return { state: "started", runId, wakeClass };
	}

	private mcpServer(sessionId: string, turnRunId: string): BrainMcpServer {
		const mcp = this.deps.mcp ?? {};
		return {
			name: "mfw_brain",
			command: mcp.command ?? "bun",
			args: ["run", mcp.script ?? mcpMainScript(), "--brain", sessionId],
			env: {
				MFW_URL:
					mcp.url ??
					process.env.MFW_URL ??
					"http://localhost:7777/mfw/api/trpc",
				MFW_PROJECT: this.deps.projectName,
				MFW_BRAIN_SESSION: sessionId,
				MFW_BRAIN_TURN: turnRunId,
			},
		};
	}

	// -----------------------------------------------------------------------
	// the digest
	// -----------------------------------------------------------------------

	private async digestInput(p: {
		session: NonNullable<Awaited<ReturnType<BrainRuntime["currentSession"]>>>;
		wakeClass: WakeClass;
		turnSeq: number;
		resumed: boolean;
		eventsFrom: number;
		eventsTo: number;
		lastTurnAt: number | null;
		now: number;
		cfg: BrainConfig;
	}): Promise<DigestInput> {
		const db = this.deps.handle.db;
		const rows = await db
			.select()
			.from(events)
			.where(
				and(
					gte(events.seq, p.eventsFrom),
					lte(events.seq, p.eventsTo),
					inArray(events.type, [...WAKE_EVENT_TYPES]),
				),
			)
			.orderBy(asc(events.seq));
		const wakeEvents: WakeEvent[] = rows.map((e) => ({
			seq: e.seq,
			ts: e.ts.getTime(),
			type: e.type,
			taskId: e.taskId,
			runId: e.runId,
			payload: e.payload,
		}));
		const kinds = await this.runKinds(wakeEvents);
		const shown = wakeEvents.filter(
			(e) => kinds.get(e.runId ?? "") !== "brain",
		);

		// Facts for runs that settled in this range: the class finalize gave
		// them, the failing checks, the review and the worker's own report.
		const settledClass = new Map<string, string>();
		for (const e of shown) {
			if (e.type === "run.settled" && e.runId) {
				settledClass.set(e.runId, String(e.payload.class ?? ""));
			}
		}
		const runFacts: DigestRunFact[] = [];
		for (const id of [...settledClass.keys()].slice(-12)) {
			const f = await this.runFact(id, settledClass.get(id) ?? null);
			if (f) runFacts.push(f);
		}
		const awaitingMap = await pruneAwaiting(this.deps.handle, {
			tasks: this.deps.tasks,
			registry: this.deps.registry,
		});
		const awaiting = [];
		for (const [taskId, a] of Object.entries(awaitingMap)) {
			const t = await this.deps.tasks.get(taskId);
			awaiting.push({
				taskId,
				title: t?.title ?? null,
				class: a.class,
				runId: a.runId,
				ageMs: Math.max(0, p.now - a.at),
			});
		}
		awaiting.sort((x, y) => y.ageMs - x.ageMs);

		// The brain's own actions since its last ok turn, with their final status.
		const [lastOk] = await db
			.select()
			.from(brainTurns)
			.where(
				and(
					eq(brainTurns.sessionId, p.session.id),
					eq(brainTurns.status, "ok"),
				),
			)
			.orderBy(desc(brainTurns.seq))
			.limit(1);
		const since = lastOk?.startedAt ?? new Date(0);
		const actionRows = await db
			.select()
			.from(brainActions)
			.where(
				and(
					eq(brainActions.sessionId, p.session.id),
					gte(brainActions.createdAt, since),
				),
			)
			.orderBy(asc(brainActions.createdAt))
			.limit(60);
		const applied = actionRows.map((a) => ({
			id: a.id,
			tool: a.tool,
			status:
				a.status === "proposed"
					? "proposed (shadow mode, not executed)"
					: a.status,
			taskId:
				typeof a.args.taskId === "string"
					? a.args.taskId
					: typeof a.args.id === "string"
						? a.args.id
						: null,
			summary: String(a.args.rationale ?? a.args.text ?? "").slice(0, 160),
			rejection: a.rejection
				? `${a.rejection.code}: ${a.rejection.message}`
				: null,
		}));

		const live = (
			await this.deps.registry.list({ states: [...LIVE_RUN_STATES] })
		)
			.filter((r) => r.kind !== "brain")
			.map((r) => ({
				runId: r.id,
				taskId: r.taskId,
				kind: r.kind,
				model: r.model,
				activity: r.activity,
				ageMs: p.now - r.startedAt.getTime(),
			}));
		const frontier = (await this.reads.frontier(20)).map((t) => ({
			id: t.id,
			title: t.title,
			unblocks: t.unblocks,
			size: t.size,
			priority: t.priority,
		}));

		const openSessions = await db
			.select()
			.from(sessions)
			.where(isNull(sessions.resolvedAt))
			.limit(10);
		const openClarifications = await db
			.select()
			.from(clarifications)
			.where(isNull(clarifications.resolvedAt))
			.limit(10);
		const humanOpen = [
			...openSessions.map((s) => `escalation ${s.source}: ${s.title}`),
			...openClarifications.map(
				(c) =>
					`${c.kind} question on run ${c.runId}: ${c.items.find((i) => i.answer === null)?.question ?? ""}`,
			),
		];

		const cap = await this.reads.capacity();
		const hourAgo = new Date(p.now - 3_600_000);
		const turnsHour = (
			await db
				.select({ startedAt: brainTurns.startedAt })
				.from(brainTurns)
				.where(gte(brainTurns.startedAt, hourAgo))
		).length;
		const capacity = [
			`Workers: ${cap.liveWorkerRuns} live of ${cap.maxConcurrent} slots.`,
			Object.keys(cap.providerHolds).length
				? `Provider holds: ${Object.entries(cap.providerHolds)
						.map(([k, h]) => `${k} (${h.reason})`)
						.join(", ")}.`
				: "No provider holds.",
			...(cap.budgets.length
				? [
						`Budgets: ${cap.budgets
							.map(
								(b) =>
									`${b.key} ${b.used.toFixed(b.unit === "usd" ? 2 : 0)}/${b.limit} ${b.unit} (${b.phase})`,
							)
							.join(", ")}.`,
					]
				: []),
			cap.mainRed?.red
				? "MAIN IS RED: nothing starts but the fix."
				: "Main is green.",
			`Spend, last 24h: workers $${cap.spendLast24h.agent.usd.toFixed(2)}, you $${cap.spendLast24h.brain.usd.toFixed(2)}.`,
		];
		const reminders: string[] = [];
		if (turnsHour >= Math.floor(p.cfg.maxTurnsPerHour * 0.75)) {
			reminders.push(
				`You have used ${turnsHour} of ${p.cfg.maxTurnsPerHour} turns this hour; batch your decisions.`,
			);
		}
		const hint = p.session.wakeHint;
		if (hint) reminders.push(`Wake hint you left: ${JSON.stringify(hint)}`);
		// Nothing expands a draft by itself: the brain spawns the planning run.
		const drafts = (await this.deps.tasks.list("draft")).filter(
			(t) => t.draftPhase === "queued" || t.draftPhase === "retrying",
		);
		if (drafts.length > 0) {
			reminders.push(
				`Drafts waiting for a plan run (spawn role plan on each): ${drafts
					.slice(0, 10)
					.map((t) => t.id)
					.join(
						", ",
					)}${drafts.length > 10 ? `, +${drafts.length - 10} more` : ""}`,
			);
		}

		let rehydration: DigestInput["rehydration"];
		if (!p.resumed) {
			const [plan] = await db
				.select()
				.from(decisions)
				.where(and(eq(decisions.kind, "plan"), eq(decisions.role, "brain")))
				.orderBy(desc(decisions.id))
				.limit(1);
			const recent = await db
				.select()
				.from(decisions)
				.where(and(eq(decisions.role, "brain"), eq(decisions.kind, "action")))
				.orderBy(desc(decisions.id))
				.limit(30);
			const weekAgo = new Date(p.now - 7 * 86_400_000);
			const overrides = await db
				.select()
				.from(decisions)
				.where(and(eq(decisions.kind, "override"), gte(decisions.ts, weekAgo)))
				.orderBy(asc(decisions.id));
			rehydration = {
				plan: plan?.reason ?? null,
				decisions: recent
					.reverse()
					.map(
						(d) =>
							`#${d.id} ${d.action}${d.taskId ? ` ${d.taskId}` : ""} (${(d.output as { status?: string }).status ?? d.status}): ${(d.reason ?? "").slice(0, 100)}`,
					),
				overrides: overrides.map(
					(d) =>
						`#${d.id} ${d.action ?? "override"}${typeof (d.input as { tool?: unknown }).tool === "string" ? ` ${(d.input as { tool: string }).tool}` : ""}${d.taskId ? ` ${d.taskId}` : ""}: ${(d.reason ?? "").slice(0, 160)}`,
				),
			};
		}

		return {
			wakeClass: p.wakeClass,
			turnSeq: p.turnSeq,
			generation: p.session.generation,
			resumed: p.resumed,
			now: p.now,
			lastTurnAt: p.lastTurnAt,
			events: shown.slice(-80),
			eventsFrom: p.eventsFrom,
			eventsTo: p.eventsTo,
			runFacts,
			applied,
			awaiting: awaiting.slice(0, 40),
			live,
			frontier,
			humanOpen,
			capacity,
			reminders,
			...(rehydration ? { rehydration } : {}),
		};
	}

	private async runFact(
		runId: string,
		settle: string | null,
	): Promise<DigestRunFact | null> {
		const run = await this.deps.registry.get(runId);
		if (!run || run.kind === "brain") return null;
		const steps = await this.deps.registry.steps(runId);
		const done = (n: string) =>
			steps.find((s) => s.step === n && s.status === "done")?.result as
				| Record<string, unknown>
				| undefined;
		const verify = done("verify") as
			| {
					passed?: boolean;
					checks?: { check: string; ok: boolean; detail?: string }[];
			  }
			| undefined;
		const scope = done("scope_check");
		const critic = done("critic") as
			| { verdict?: string; reason?: string }
			| undefined;
		const report = done("ingest_report") as
			| { report?: { status?: string; summary?: string; question?: string } }
			| undefined;
		const failing = verify?.checks?.filter((c) => !c.ok) ?? [];
		return {
			runId,
			taskId: run.taskId,
			kind: run.kind,
			model: run.model,
			harness: run.harness ?? run.providerId,
			state: run.state,
			outcome: run.outcome,
			...(settle ? { settle } : {}),
			costUsd:
				typeof run.usage?.costUsd === "number" ? run.usage.costUsd : null,
			durationMs: run.finishedAt
				? run.finishedAt.getTime() - run.startedAt.getTime()
				: null,
			verify: verify
				? verify.passed
					? "passed"
					: `failed: ${failing.map((c) => `${c.check}${c.detail ? ` (${c.detail.slice(0, 120)})` : ""}`).join("; ") || "unknown"}`
				: null,
			scope: scope
				? `${String(scope.files ?? "?")} files, ${String(scope.outside ?? 0)} outside owns`
				: null,
			verdict: critic?.verdict
				? `${critic.verdict}${critic.reason ? `: ${critic.reason.slice(0, 160)}` : ""}`
				: null,
			question: report?.report?.question?.slice(0, 200) ?? null,
			report: report?.report?.status
				? `${report.report.status}${report.report.summary ? `: ${report.report.summary.slice(0, 200)}` : ""}`
				: null,
		};
	}

	// -----------------------------------------------------------------------
	// closing turns
	// -----------------------------------------------------------------------

	/** Close every running turn whose run is over (or never existed). Idempotent. */
	async reconcileTurns(): Promise<number> {
		const running = await this.deps.handle.db
			.select()
			.from(brainTurns)
			.where(eq(brainTurns.status, "running"));
		let closed = 0;
		for (const t of running) {
			const run = await this.deps.registry.get(t.runId);
			if (!run) {
				// Crash between the turn row and the run row: nothing launched.
				await this.endTurn(t.runId, "aborted", {
					error: "run was never created",
				});
				closed++;
				continue;
			}
			if (!TERMINAL_RUN_STATES.has(run.state)) continue;
			await this.closeFromRun(t.runId, run);
			closed++;
		}
		return closed;
	}

	private async closeFromRun(runId: string, run: RunRow) {
		const { fatal, resumeFailed } = await this.turnFacts(run);
		let status: Exclude<BrainTurnStatus, "running">;
		let error: string | null = null;
		if (
			run.killReason === "watchdog-wall" ||
			run.killReason === "watchdog-idle"
		) {
			status = "timeout";
			error = `killed: ${run.killReason}`;
		} else if (run.killReason === "manual" || run.outcome === "killed_manual") {
			status = "aborted";
			error = "stopped";
		} else if (
			run.state === "completed" &&
			(run.exitCode ?? 0) === 0 &&
			!fatal
		) {
			status = "ok";
		} else {
			status = "failed";
			error =
				fatal ??
				run.note ??
				`run ended ${run.state}${run.outcome ? ` (${run.outcome})` : ""}${run.exitCode ? `, exit ${run.exitCode}` : ""}`;
		}
		await this.endTurn(runId, status, {
			error,
			usage: run.usage,
			nativeSessionId: run.nativeSessionId,
			resumeFailed: status !== "ok" && resumeFailed,
			run,
		});
	}

	/** Fatal error text and whether the harness said the session is gone. */
	private async turnFacts(run: RunRow): Promise<{
		fatal: string | null;
		resumeFailed: boolean;
	}> {
		let fatal: string | null = null;
		let text = "";
		try {
			const { chunk } = await this.deps.registry.readOutput(
				run.id,
				"events.jsonl",
			);
			for (const e of parseAgentEvents(chunk)) {
				if (e.type === "error" && e.fatal) {
					fatal = e.message;
					text += `${e.message}\n`;
				}
			}
			const raw = await this.deps.registry.readOutput(run.id, "raw.log");
			text += raw.chunk;
		} catch {
			// best-effort: a missing transcript reads as no evidence
		}
		return { fatal, resumeFailed: RESUME_FAILURE.test(text) };
	}

	/**
	 * Final write for a turn, in one transaction: the turn row, the session
	 * (cursor only on `ok`), the ledger delta and `brain.turn_ended`. Safe to
	 * run twice: a turn that is no longer `running` is left alone.
	 */
	private async endTurn(
		runId: string,
		status: Exclude<BrainTurnStatus, "running">,
		opts: {
			error?: string | null;
			usage?: Record<string, number> | null;
			nativeSessionId?: string | null;
			resumeFailed?: boolean;
			run?: RunRow;
		},
	): Promise<void> {
		const nowMs = this.now();
		const cfg = this.deps.config();
		const published: StoredEvent[] = [];
		let notify: {
			sessionId: string;
			failures: number;
			error: string | null;
		} | null = null;
		let rollover: { sessionId: string; harness: string; model: string } | null =
			null;

		await this.deps.handle.withTx(async (tx) => {
			const [turn] = await tx
				.select()
				.from(brainTurns)
				.where(eq(brainTurns.runId, runId));
			if (turn?.status !== "running") return;
			const [s] = await tx
				.select()
				.from(brainSessions)
				.where(eq(brainSessions.id, turn.sessionId));
			if (!s) return;

			// Spend: this turn's delta against the session's running total.
			let deltaUsd: number | null = null;
			if (opts.usage && Object.keys(opts.usage).length > 0 && opts.run) {
				const accountKey =
					typeof opts.run.routing?.holdKey === "string"
						? opts.run.routing.holdKey
						: (opts.run.providerId ?? "unknown");
				const r = await recordBrainUsage(tx, {
					runId,
					accountKey,
					brainSessionId: s.id,
					cumulative: opts.usage,
					previous:
						turn.resumed && s.lastCostTotal !== null
							? { costUsd: s.lastCostTotal }
							: null,
					ts: new Date(nowMs),
				});
				deltaUsd = r?.usd ?? null;
			}
			const sessionPatch: Partial<typeof brainSessions.$inferInsert> = {
				leaseOwner: null,
				leaseUntil: null,
			};
			const u = opts.usage;
			if (u && typeof u.costUsd === "number")
				sessionPatch.lastCostTotal = u.costUsd;
			if (u && typeof u.inputTokens === "number") {
				sessionPatch.contextTokens =
					u.inputTokens +
					(typeof u.cachedInputTokens === "number" ? u.cachedInputTokens : 0);
			}

			if (status === "ok") {
				sessionPatch.cursor = Math.max(s.cursor, turn.eventsTo);
				sessionPatch.consecutiveFailures = 0;
				sessionPatch.retryAfter = null;
				sessionPatch.status = s.status === "paused" ? "paused" : "idle";
				// Codex reports its thread id only after the first turn.
				if (!s.nativeSessionId && opts.nativeSessionId) {
					sessionPatch.nativeSessionId = opts.nativeSessionId;
				}
			} else if (opts.resumeFailed && turn.resumed) {
				// The native session is unusable: not the brain's fault. Roll
				// over; the same events are re-delivered to the new generation.
				sessionPatch.status = "idle";
				rollover = { sessionId: s.id, harness: s.harness, model: s.model };
			} else if (status === "aborted") {
				// A stopped or orphaned turn closing late must not reopen a circuit.
				sessionPatch.status = s.status === "failed" ? "failed" : "idle";
			} else {
				const failures = s.consecutiveFailures + 1;
				const limit = cfg?.failureLimit ?? BRAIN_DEFAULTS.failureLimit;
				sessionPatch.consecutiveFailures = failures;
				const backoff = Math.min(
					BRAIN_DEFAULTS.retryBaseMs * 2 ** (failures - 1),
					BRAIN_DEFAULTS.retryMaxMs,
				);
				sessionPatch.retryAfter = new Date(nowMs + backoff);
				if (failures >= limit) {
					sessionPatch.status = "failed";
					notify = {
						sessionId: s.id,
						failures,
						error: opts.error ?? null,
					};
				} else {
					sessionPatch.status = "idle";
				}
			}
			await tx
				.update(brainSessions)
				.set(sessionPatch)
				.where(eq(brainSessions.id, s.id));
			await tx
				.update(brainTurns)
				.set({
					status,
					endedAt: new Date(nowMs),
					error: opts.error ?? null,
					usage: opts.usage
						? { ...opts.usage, ...(deltaUsd !== null ? { deltaUsd } : {}) }
						: null,
				})
				.where(eq(brainTurns.runId, runId));
			published.push(
				await appendEvent(
					tx,
					{
						type: "brain.turn_ended",
						runId,
						payload: {
							sessionId: s.id,
							status,
							actionsCount: turn.actionsCount,
							...(opts.error ? { error: opts.error.slice(0, 500) } : {}),
						},
					},
					nowMs,
				),
			);
		});
		this.deps.bus.publish(published);
		this.reads.forget(runId);

		if (rollover) {
			const r = rollover as {
				sessionId: string;
				harness: string;
				model: string;
			};
			await this.rollover(r.sessionId, "resume_failed", {
				provider: r.harness,
				model: r.model,
			});
		}
		if (notify) {
			const n = notify as {
				sessionId: string;
				failures: number;
				error: string | null;
			};
			if (!this.stuckNotified.has(n.sessionId)) {
				this.stuckNotified.add(n.sessionId);
				this.deps.log.error(n, "brain circuit open: repeated failed turns");
				await this.deps.notifyStuck?.(n)?.catch?.(() => {});
			}
		}
	}

	// -----------------------------------------------------------------------
	// read model for the API
	// -----------------------------------------------------------------------

	async view() {
		const s = await this.currentSession();
		const cfg = this.deps.config();
		if (!s) return { enabled: cfg !== null, session: null };
		const db = this.deps.handle.db;
		const dayAgo = new Date(this.now() - 86_400_000);
		const turns = await db
			.select()
			.from(brainTurns)
			.where(
				and(eq(brainTurns.sessionId, s.id), gte(brainTurns.startedAt, dayAgo)),
			)
			.orderBy(desc(brainTurns.seq));
		const spend = await spendTotals(db, { since: dayAgo, kind: "brain" });
		return {
			enabled: cfg !== null,
			session: {
				...s,
				turnsLast24h: turns.length,
				liveTurnRunId: turns.find((t) => t.status === "running")?.runId ?? null,
				lastTurn: turns[0] ?? null,
				spendLast24hUsd: spend.usd,
			},
		};
	}

	async turnList(opts: { limit?: number; beforeSeq?: number } = {}) {
		const s = await this.currentSession();
		if (!s) return [];
		return this.deps.handle.db
			.select()
			.from(brainTurns)
			.where(
				and(
					eq(brainTurns.sessionId, s.id),
					...(opts.beforeSeq ? [lte(brainTurns.seq, opts.beforeSeq - 1)] : []),
				),
			)
			.orderBy(desc(brainTurns.seq))
			.limit(Math.min(opts.limit ?? 50, 200));
	}

	async decisionList(opts: {
		taskId?: string;
		kind?: string;
		turnRunId?: string;
		beforeId?: number;
		limit?: number;
	}) {
		const conds = [
			// The brain's own calls, and the two things a person does to it: an
			// override of a call and a message (the feed shows what steered it).
			or(
				eq(decisions.role, "brain"),
				eq(decisions.kind, "override"),
				eq(decisions.action, "brain.message"),
			),
			...(opts.taskId ? [eq(decisions.taskId, opts.taskId)] : []),
			...(opts.kind ? [eq(decisions.kind, opts.kind as never)] : []),
			...(opts.turnRunId ? [eq(decisions.turnRunId, opts.turnRunId)] : []),
			...(opts.beforeId ? [lte(decisions.id, opts.beforeId - 1)] : []),
		];
		return this.deps.handle.db
			.select()
			.from(decisions)
			.where(and(...conds))
			.orderBy(desc(decisions.id))
			.limit(Math.min(opts.limit ?? 50, 200));
	}

	async latestPlan() {
		const [d] = await this.deps.handle.db
			.select()
			.from(decisions)
			.where(and(eq(decisions.role, "brain"), eq(decisions.kind, "plan")))
			.orderBy(desc(decisions.id))
			.limit(1);
		return d
			? {
					decisionId: d.id,
					ts: d.ts.getTime(),
					turnRunId: d.turnRunId,
					markdown: d.reason ?? "",
				}
			: null;
	}
}
