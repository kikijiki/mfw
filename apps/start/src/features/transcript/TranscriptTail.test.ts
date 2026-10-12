import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptEntry, type TranscriptItem } from "./entries";
import { tailItems } from "./TranscriptTail";

const pending = {
	kind: "approval",
	seq: 4,
	requestId: "req-1",
	approvalKind: "command",
	status: "pending",
	summary: "run the migration",
} as unknown as TranscriptItem;

function render(props: Partial<Parameters<typeof TranscriptEntry>[0]>) {
	return renderToStaticMarkup(
		createElement(TranscriptEntry, {
			item: pending,
			density: "tail",
			expanded: false,
			onToggle: () => {},
			...props,
		}),
	);
}

describe("approvals on the dense tail", () => {
	test("a pending approval is answerable where it is first seen", () => {
		const html = render({ onApproval: () => {} });
		expect(html).toContain('aria-label="Accept approval req-1"');
		expect(html).toContain('aria-label="For session approval req-1"');
		expect(html).toContain('aria-label="Decline approval req-1"');
	});

	test("no handler (a run that cannot take an answer) shows no buttons", () => {
		expect(render({})).not.toContain("approval req-1");
	});

	test("an answer in flight disables the buttons", () => {
		const html = render({ onApproval: () => {}, approvalPending: true });
		expect(html.match(/disabled=""/g)?.length).toBe(3);
	});
});

describe("tailItems", () => {
	test("keeps the last N in the order items last changed", () => {
		const items = [
			{ kind: "message", seq: 1, latestSeq: 9 },
			{ kind: "message", seq: 2 },
			{ kind: "message", seq: 3 },
		] as unknown as TranscriptItem[];
		expect(tailItems(items, 2).map((i) => i.seq)).toEqual([3, 1]);
		// Never mutates the memoized source array.
		expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
	});
});
