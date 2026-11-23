import type { ClaimClass } from "@mfw/daemon/claims";
import type { RunProvenanceView } from "@mfw/daemon/run-provenance-view";
import { Chip } from "../../components/Page";

type ExitValue = NonNullable<RunProvenanceView["exit"]["observed"]>;

function exitText(exit: ExitValue): string {
	if (exit.kind === "exit") return `exit ${exit.code}`;
	if (exit.kind === "killed") return `killed (${exit.reason})`;
	return "an unreadable exit";
}

/** The same words as the exit chips, for any typed claim. */
export const CLAIM_CHIP: Record<
	ClaimClass,
	{ label: string; tone: "ok" | "neutral" | "warn"; title: string }
> = {
	"host-observed": {
		label: "host saw",
		tone: "ok",
		title: "host-observed: the host saw this itself",
	},
	"agent-reported": {
		label: "agent says",
		tone: "neutral",
		title: "sandbox-reported: not verified by the host",
	},
	inference: {
		label: "inferred",
		tone: "neutral",
		title: "inference: computed or written by the brain, not observed",
	},
};

/** One chip per weaker class, naming the parts it covers. Host parts need none. */
export function ClaimChips({
	parts,
}: {
	parts: readonly { key: string; text: string; claimClass: ClaimClass }[];
}) {
	const weak = (["agent-reported", "inference"] as const).flatMap((c) => {
		const of = parts.filter((p) => p.claimClass === c);
		return of.length ? [{ c, of }] : [];
	});
	return (
		<>
			{weak.map(({ c, of }) => (
				<Chip key={c} tone={CLAIM_CHIP[c].tone} title={CLAIM_CHIP[c].title}>
					{`${CLAIM_CHIP[c].label}: ${of.map((p) => p.key.replace("_", " ")).join(", ")}`}
				</Chip>
			))}
		</>
	);
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
			{provenance.claims?.map((c) => (
				<Chip key={c.text} tone="ok" title={CLAIM_CHIP[c.class].title}>
					{`${CLAIM_CHIP[c.class].label} ${c.text}`}
				</Chip>
			))}
			{provenance.reportStatus ? (
				<Chip tone="neutral" title="sandbox-reported: from the agent's report">
					{`agent says ${provenance.reportStatus}`}
				</Chip>
			) : null}
		</>
	);
}
