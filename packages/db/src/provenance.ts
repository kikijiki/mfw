/**
 * L1 run facts and where each one came from (design "Bridge on the host").
 *
 * - `host-observed`: the host derived it from its own observation: the exit
 *   status of the process it launched, files it measured, probe results.
 * - `sandbox-reported`: anything read from the outbox or sent by the agent: its
 *   exit claim, progress, usage, report, self-assessed status.
 *
 * One row per (run, fact, provenance), so a host observation and an agent's
 * contradicting claim are stored side by side and neither overwrites the
 * other. A row count per run is bounded by construction, whatever an agent
 * emits. Only host-observed facts may back a verdict or a "mechanical" claim.
 */

export const FACT_PROVENANCE = ["host-observed", "sandbox-reported"] as const;
export type FactProvenance = (typeof FACT_PROVENANCE)[number];

export function isFactProvenance(value: unknown): value is FactProvenance {
	return (FACT_PROVENANCE as readonly unknown[]).includes(value);
}

/** Which provenance each fact may carry. A closed table: a new fact is added here. */
export const RUN_FACT_PROVENANCE = {
	/** Either: a remote or pre-split run's exit file is not the host's own observation. */
	exit: FACT_PROVENANCE,
	/** Follows the exit it was derived from. */
	outcome: FACT_PROVENANCE,
	scope: ["host-observed"],
	agent_exit_claim: ["sandbox-reported"],
	/** The host's own verified import (or refusal) of a clone run's result. */
	result_import: ["host-observed"],
	/** What the in-sandbox WIP helper said about its final snapshot. */
	wip_claim: ["sandbox-reported"],
	report: ["sandbox-reported"],
	usage: ["sandbox-reported"],
	usage_live: ["sandbox-reported"],
	activity: ["sandbox-reported"],
	capabilities: ["sandbox-reported"],
	native_session: ["sandbox-reported"],
	subagents: ["sandbox-reported"],
	transcript_summary: ["sandbox-reported"],
} as const satisfies Record<string, readonly FactProvenance[]>;

/**
 * Where each spend source comes from. Figures a run reports about itself are
 * shown, and never count toward a hard budget stop.
 */
export const SPEND_SOURCE_PROVENANCE = {
	run_usage: "sandbox-reported",
	brain_usage: "sandbox-reported",
	runpod_billing: "host-observed",
	host_slot_time: "host-observed",
} as const satisfies Record<string, FactProvenance>;

export const REPORTED_SPEND_SOURCES = (
	Object.keys(
		SPEND_SOURCE_PROVENANCE,
	) as (keyof typeof SPEND_SOURCE_PROVENANCE)[]
).filter((s) => SPEND_SOURCE_PROVENANCE[s] === "sandbox-reported");

export type RunFactKind = keyof typeof RUN_FACT_PROVENANCE;
export const RUN_FACT_KINDS = Object.keys(RUN_FACT_PROVENANCE) as RunFactKind[];

/** Each kind with the provenance it allows, as the writer's argument type. */
export type RunFactTag = {
	[K in RunFactKind]: {
		fact: K;
		provenance: (typeof RUN_FACT_PROVENANCE)[K][number];
	};
}[RunFactKind];

export const RUN_FACT_SOURCES = [
	"host-exit-record",
	"control-exit",
	"flat-exit",
	"outbox-exit",
	"finalize",
	"reconcile",
	"scope-watchdog",
	"report-file",
	"transcript",
	"driver-hello",
	"brain-call",
	"host-git-import",
	"outbox-wip-ack",
] as const;
export type RunFactSource = (typeof RUN_FACT_SOURCES)[number];

/** Egress counters come from the host-side proxy, so they carry only this. */
export const RUN_EGRESS_PROVENANCE = "host-observed" satisfies FactProvenance;

const quoted = (values: readonly string[]) =>
	values.map((v) => `'${v}'`).join(", ");

/** The SQL CHECK of the (fact, provenance) pairs; the latest migration touching `run_facts` holds this text. */
export function runFactsPairCheck(): string {
	const groups = new Map<string, string[]>();
	for (const kind of RUN_FACT_KINDS) {
		const key = quoted(RUN_FACT_PROVENANCE[kind]);
		groups.set(key, [...(groups.get(key) ?? []), kind]);
	}
	return [...groups]
		.map(
			([provenance, kinds]) =>
				`(fact IN (${quoted(kinds)}) AND provenance IN (${provenance}))`,
		)
		.join(" OR ");
}

/** The SQL CHECK of `run_egress.provenance`. */
export const RUN_EGRESS_PROVENANCE_CHECK = `provenance = '${RUN_EGRESS_PROVENANCE}'`;

/** The SQL CHECK of the closed provenance enum. */
export const RUN_FACTS_PROVENANCE_CHECK = `provenance IN (${quoted(FACT_PROVENANCE)})`;
