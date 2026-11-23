import { describe, expect, test } from "bun:test";
import type { RunProvenanceView } from "@mfw/daemon/run-provenance-view";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimChips, egressTitle, ProvenanceChips } from "./ProvenanceChips";

const view = (
	exit: RunProvenanceView["exit"],
	reportStatus: string | null = null,
): RunProvenanceView => ({ exit, reportStatus, facts: [] });

const render = (v: RunProvenanceView | null) =>
	renderToStaticMarkup(<ProvenanceChips provenance={v} />);

describe("ProvenanceChips", () => {
	test("egress shows as host-observed traffic with its denials", () => {
		const egress: NonNullable<RunProvenanceView["egress"]> = {
			provenance: "host-observed",
			bytesUp: 2048,
			bytesDown: 3 * 1024 * 1024,
			denied: 2,
			destinations: [
				{
					destination: "evil.test:443",
					bytesUp: 0,
					bytesDown: 0,
					connections: 0,
					denied: 2,
					lastDeniedReason: "not-allowlisted",
				},
			],
		};
		const html = render({
			...view({ observed: null, agentSays: null, disagree: false }),
			egress,
		});
		expect(html).toContain("host saw 2.0 KB up, 3.0 MB down, 2 denied");
		expect(egressTitle(egress)).toContain(
			"evil.test:443: 2 denied (not-allowlisted)",
		);
	});

	test("no egress record, no egress chip", () => {
		const html = render(
			view({ observed: null, agentSays: null, disagree: false }),
		);
		expect(html).not.toContain(" up, ");
	});

	test("a forged success renders as the agent's claim beside the host's exit", () => {
		const html = render(
			view(
				{
					observed: { kind: "exit", code: 3 },
					agentSays: { kind: "exit", code: 0 },
					disagree: true,
				},
				"success",
			),
		);
		expect(html).toContain("host saw exit 3");
		expect(html).toContain("agent says exit 0 (disputed)");
		expect(html).toContain("agent says success");
		// The only unprefixed exit is the host's.
		expect(html.replaceAll("agent says exit 0", "")).not.toContain("exit 0");
	});

	test("a sandbox-only exit is never shown as a plain fact", () => {
		const html = render(
			view({
				observed: null,
				agentSays: { kind: "exit", code: 0 },
				disagree: false,
			}),
		);
		expect(html).toContain("agent says exit 0");
		expect(html).not.toContain("host saw");
		expect(html).not.toContain("disputed");
	});

	test("a host-observed exit shows no agent chip", () => {
		const html = render(
			view({
				observed: { kind: "exit", code: 0 },
				agentSays: null,
				disagree: false,
			}),
		);
		expect(html).toContain("host saw exit 0");
		expect(html).not.toContain("agent says");
	});

	test("agent text is escaped", () => {
		const html = render(
			view({
				observed: null,
				agentSays: { kind: "killed", reason: "<img src=x>" },
				disagree: false,
			}),
		);
		expect(html).not.toContain("<img");
	});

	test("no facts render nothing", () => {
		expect(render(null)).toBe("");
		expect(
			render(view({ observed: null, agentSays: null, disagree: false })),
		).toBe("");
	});
});

describe("claim chips", () => {
	test("a run's host-backed claim reads as the host's", () => {
		const html = render({
			...view({ observed: null, agentSays: null, disagree: false }),
			claims: [
				{
					class: "host-observed",
					text: "merged",
					word: "merged",
					subject: { kind: "run", id: "r" },
					weakened: false,
					records: [{ kind: "merge", seq: 1 }],
				},
			],
		});
		expect(html).toContain("host saw merged");
	});

	test("weaker headline parts are named, host parts need no chip", () => {
		const html = renderToStaticMarkup(
			<ClaimChips
				parts={[
					{ key: "landed", text: "Landed 1", claimClass: "host-observed" },
					{ key: "needs_you", text: "needs you 1", claimClass: "inference" },
					{ key: "main", text: "main green", claimClass: "inference" },
					{ key: "spend", text: "spend 5%", claimClass: "agent-reported" },
				]}
			/>,
		);
		expect(html).toContain("inferred: needs you, main");
		expect(html).toContain("agent says: spend");
		expect(html).not.toContain("landed");
	});
});
