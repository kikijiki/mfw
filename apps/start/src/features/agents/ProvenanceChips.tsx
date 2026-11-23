import type { RunProvenanceView } from "@mfw/daemon/run-provenance-view";
import { Chip } from "../../components/Page";

type ExitValue = NonNullable<RunProvenanceView["exit"]["observed"]>;

function exitText(exit: ExitValue): string {
	if (exit.kind === "exit") return `exit ${exit.code}`;
	if (exit.kind === "killed") return `killed (${exit.reason})`;
	return "an unreadable exit";
}

/**
 * Who vouches for a run's exit. The words are on the chip itself: "host saw" only
 * for a host-observed value, "agent says" for anything from the sandbox.
 */
export function ProvenanceChips({
	provenance,
}: {
	provenance: RunProvenanceView | null | undefined;
}) {
	if (!provenance) return null;
	const { observed, agentSays, disagree } = provenance.exit;
	const failed =
		observed !== null && observed.kind !== "exit"
			? true
			: observed?.kind === "exit" && observed.code !== 0;
	return (
		<>
			{observed ? (
				<Chip
					tone={failed ? "critical" : "ok"}
					title="host-observed: the host saw this itself"
				>
					{`host saw ${exitText(observed)}`}
				</Chip>
			) : null}
			{agentSays ? (
				<Chip
					tone={disagree ? "warn" : "neutral"}
					title={
						disagree
							? "sandbox-reported, and it contradicts what the host observed"
							: "sandbox-reported: not verified by the host"
					}
				>
					{`agent says ${exitText(agentSays)}${disagree ? " (disputed)" : ""}`}
				</Chip>
			) : null}
			{provenance.reportStatus ? (
				<Chip tone="neutral" title="sandbox-reported: from the agent's report">
					{`agent says ${provenance.reportStatus}`}
				</Chip>
			) : null}
		</>
	);
}
