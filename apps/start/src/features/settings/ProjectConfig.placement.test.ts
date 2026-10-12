import { describe, expect, test } from "bun:test";
import { routingDraft, routingOf } from "./ProjectConfig";

type Draft = Parameters<typeof routingOf>[0];
const draft = (fields: ReturnType<typeof routingDraft>) =>
	fields as unknown as Draft;

describe("project placement setting", () => {
	test("placement is typed; the rest of routing stays JSON, and both round-trip", () => {
		const stored = {
			placement: { target: "ssh" as const, labels: ["gpu"] },
			escalateOnRepair: true,
		};
		const fields = routingDraft(stored);
		expect(fields).toEqual({
			routingJson: JSON.stringify({ escalateOnRepair: true }, null, 2),
			placement: "ssh",
			placementLabels: "gpu",
		});
		expect(routingOf(draft(fields))).toEqual(stored);
	});

	test("a pinned host, local placement and an empty routing", () => {
		expect(
			routingOf(
				draft({ routingJson: "", placement: "ssh:box-a", placementLabels: "" }),
			),
		).toEqual({ placement: { target: "ssh", host: "box-a" } });
		// Local drops placement; nothing left means no routing at all.
		expect(
			routingOf(
				draft({ routingJson: "", placement: "local", placementLabels: "gpu" }),
			),
		).toBeNull();
		// A placement typed into the JSON never overrides the control.
		expect(
			routingOf(
				draft({
					routingJson: '{"placement":{"target":"ssh"}}',
					placement: "local",
					placementLabels: "",
				}),
			),
		).toBeNull();
	});
});
