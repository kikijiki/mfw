import type { ProjectDb } from "@mfw/db/client";
import type { FactProvenance, RunFactKind } from "@mfw/db/provenance";
import {
	foldRunExit,
	listRunFacts,
	type RunExitProvenance,
} from "@mfw/db/run-facts";

/** What a run view may say about a run's facts and who vouches for each. */
export interface RunProvenanceView {
	exit: RunExitProvenance;
	/** The status in the agent's report: always a claim. Null when absent or malformed. */
	reportStatus: string | null;
	facts: { fact: RunFactKind; provenance: FactProvenance }[];
}

const REPORT_STATUS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export async function runProvenanceView(
	db: ProjectDb,
	runId: string,
): Promise<RunProvenanceView> {
	const facts = await listRunFacts(db, runId);
	const report = facts.find((f) => f.fact === "report")?.value;
	const status =
		typeof report === "object" && report !== null
			? (report as Record<string, unknown>).status
			: null;
	return {
		exit: foldRunExit(facts),
		reportStatus:
			typeof status === "string" && REPORT_STATUS.test(status) ? status : null,
		facts: facts.map(({ fact, provenance }) => ({ fact, provenance })),
	};
}
