import { and, asc, eq, sql } from "drizzle-orm";
import type { ProjectDb, ProjectDbTx } from "./client.ts";
import {
	type FactProvenance,
	isFactProvenance,
	RUN_FACT_PROVENANCE,
	type RunFactKind,
	type RunFactSource,
	type RunFactTag,
} from "./provenance.ts";
import { runFacts } from "./schema.ts";

/** The largest stored value. An agent controls these bytes. */
export const RUN_FACT_MAX_BYTES = 16 * 1024;

function boundedJson(value: unknown): string {
	const json = JSON.stringify(value ?? null);
	const bytes = Buffer.byteLength(json);
	return bytes <= RUN_FACT_MAX_BYTES
		? json
		: JSON.stringify({ truncated: true, bytes });
}

export type RunFactInput = RunFactTag & {
	runId: string;
	value: unknown;
	source: RunFactSource;
	at?: Date;
};

/**
 * The one writer of `run_facts`. A later value replaces the row for the same
 * (run, fact, provenance), except a host-observed exit, which is write-once: a
 * process exits once, so a replay after a crash can never rewrite it.
 */
export async function recordRunFact(
	tx: ProjectDb | ProjectDbTx,
	input: RunFactInput,
): Promise<void> {
	const allowed: readonly FactProvenance[] = RUN_FACT_PROVENANCE[input.fact];
	if (!allowed.includes(input.provenance)) {
		throw new Error(`fact ${input.fact} cannot be ${input.provenance}`);
	}
	const at = input.at ?? new Date();
	const row = {
		runId: input.runId,
		fact: input.fact,
		provenance: input.provenance,
		value: boundedJson(input.value),
		source: input.source,
		firstObservedAt: at,
		observedAt: at,
	};
	const insert = tx.insert(runFacts).values(row);
	if (input.fact === "exit" && input.provenance === "host-observed") {
		await insert.onConflictDoNothing();
		return;
	}
	await insert.onConflictDoUpdate({
		target: [runFacts.runId, runFacts.fact, runFacts.provenance],
		set: {
			value: sql`excluded.value`,
			source: sql`excluded.source`,
			observedAt: sql`excluded.observed_at`,
		},
	});
}

export interface RunFactView {
	fact: RunFactKind;
	provenance: FactProvenance;
	value: unknown;
	source: string;
	observedAt: number;
}

function parseStored(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export async function listRunFacts(
	db: ProjectDb | ProjectDbTx,
	runId: string,
	fact?: RunFactKind,
): Promise<RunFactView[]> {
	const rows = await db
		.select()
		.from(runFacts)
		.where(
			fact
				? and(eq(runFacts.runId, runId), eq(runFacts.fact, fact))
				: eq(runFacts.runId, runId),
		)
		.orderBy(asc(runFacts.fact), asc(runFacts.provenance));
	return rows.flatMap((r) =>
		// A row outside the closed sets is dropped, never shown with a guessed tag.
		isFactProvenance(r.provenance) && r.fact in RUN_FACT_PROVENANCE
			? [
					{
						fact: r.fact as RunFactKind,
						provenance: r.provenance,
						value: parseStored(r.value),
						source: r.source,
						observedAt: r.observedAt.getTime(),
					},
				]
			: [],
	);
}

export type ExitFactValue =
	| { kind: "exit"; code: number }
	| { kind: "killed"; reason: string }
	| { kind: "invalid" };

function asExit(value: unknown): ExitFactValue | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (v.kind === "exit" && Number.isInteger(v.code)) {
		return { kind: "exit", code: v.code as number };
	}
	if (v.kind === "killed" && typeof v.reason === "string") {
		return { kind: "killed", reason: v.reason };
	}
	return v.kind === "invalid" ? { kind: "invalid" } : null;
}

/** What a view may say about a run's exit. */
export interface RunExitProvenance {
	/** Only ever from a host-observed row. */
	observed: ExitFactValue | null;
	/** The agent's claim, or an exit the host could not observe itself. */
	agentSays: ExitFactValue | null;
	/** Both exist and differ. */
	disagree: boolean;
}

const sameExit = (a: ExitFactValue, b: ExitFactValue) =>
	JSON.stringify(a) === JSON.stringify(b);

export function foldRunExit(facts: readonly RunFactView[]): RunExitProvenance {
	const pick = (fact: RunFactKind, provenance: FactProvenance) =>
		asExit(
			facts.find((f) => f.fact === fact && f.provenance === provenance)?.value,
		);
	const observed = pick("exit", "host-observed");
	const agentSays =
		pick("agent_exit_claim", "sandbox-reported") ??
		pick("exit", "sandbox-reported");
	return {
		observed,
		agentSays,
		disagree: !!observed && !!agentSays && !sameExit(observed, agentSays),
	};
}
