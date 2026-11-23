import { describe, expect, test } from "bun:test";
import type { RunProvenanceView } from "@mfw/daemon/run-provenance-view";
import { renderToStaticMarkup } from "react-dom/server";
import { ProvenanceChips } from "./ProvenanceChips";

const view = (
	exit: RunProvenanceView["exit"],
	reportStatus: string | null = null,
): RunProvenanceView => ({ exit, reportStatus, facts: [] });

const render = (v: RunProvenanceView | null) =>
	renderToStaticMarkup(<ProvenanceChips provenance={v} />);

describe("ProvenanceChips", () => {
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
