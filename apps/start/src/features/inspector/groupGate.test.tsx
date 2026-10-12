import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { DiffView, type ReviewFile } from "../review/DiffView";
import { GroupCompareView } from "./GroupCompare";
import {
	diffTotals,
	type GroupAttempt,
	type GroupData,
	liveAttemptIds,
	mirrorGate,
	type SelectBlock,
	selectGate,
} from "./groupGate";

// AppLink prefixes hrefs with the build-time mount, which bun test does not define.
import.meta.env.BASE_URL ??= "/";

const T0 = new Date(Date.UTC(2026, 9, 12, 10, 0, 0));

function attempt(
	id: string,
	over: Partial<GroupAttempt> = {},
	facts: Partial<GroupAttempt["facts"]> = {},
): GroupAttempt {
	return {
		runId: id,
		label: `T-1#${id}`,
		role: "attempt",
		state: "completed",
		activity: null,
		harness: "claude-cli",
		model: "claude-opus-4-7",
		effort: null,
		host: null,
		startedAt: T0,
		finishedAt: new Date(T0.getTime() + 90_000),
		costUsd: 0.42,
		note: `${id} says it is done`,
		winner: false,
		checks: [{ name: "typecheck", ok: true }],
		facts: {
			settled: true,
			verified: true,
			verifyRan: true,
			scopeOutside: 0,
			review: null,
			...facts,
		},
		select: { ok: true },
		...over,
	} as GroupAttempt;
}

const reject = (
	code: string,
	message: string,
	fix: string,
): GroupAttempt["select"] => ({
	ok: false,
	rejection: { code, message, fix: { kind: "ui", text: fix } },
});

function group(over: Partial<GroupData> = {}): GroupData {
	return {
		id: "G1",
		taskId: "T-1",
		kind: "competing",
		selection: "brain",
		status: "open",
		winnerRunId: null,
		createdBy: "decision:7",
		createdAt: T0,
		closedAt: null,
		selectedBy: null,
		attempts: [attempt("A1"), attempt("A2")],
		...over,
	} as GroupData;
}

describe("select gate mirrors the server's I2 check", () => {
	// One attempt per way the server's validator refuses, with the codes it uses.
	const cases: {
		name: string;
		group?: Partial<GroupData>;
		facts: Partial<GroupAttempt["facts"]>;
		code: SelectBlock | null;
	}[] = [
		{ name: "verified, settled, in scope", facts: {}, code: null },
		{ name: "not verified", facts: { verified: false }, code: "not_verified" },
		{
			name: "verified but still running",
			facts: { settled: false },
			code: "run_not_settled",
		},
		{
			name: "outside its scope",
			facts: { scopeOutside: 2 },
			code: "scope_outside",
		},
		{
			name: "reviewed down",
			facts: { review: { status: "ok", verdict: "fix" } },
			code: "review_not_passed",
		},
		{
			name: "the critic failed",
			facts: { review: { status: "failed", verdict: null } },
			code: "review_not_passed",
		},
		{
			name: "review allows it",
			facts: { review: { status: "ok", verdict: "merge" } },
			code: null,
		},
		{
			name: "group already decided",
			group: { status: "selecting" },
			facts: {},
			code: "group_closed",
		},
		{
			// the server checks the group first, then verification
			name: "decided group wins over an unverified attempt",
			group: { status: "merged" },
			facts: { verified: false },
			code: "group_closed",
		},
	];

	test.each(cases)("$name", ({ group: g, facts, code }) => {
		const grp = group(g);
		const a = attempt("A1", {}, facts);
		expect(mirrorGate(grp, a)).toBe(code);
	});

	test("the server's verdict is the authority: its refusal disables the button and carries its fix", () => {
		const a = attempt(
			"A1",
			{
				select: reject(
					"not_verified",
					"A1 has not passed verification",
					"Only a run that settled verified can win; request a repair or another attempt.",
				),
			},
			{ verified: false },
		);
		const gate = selectGate(group(), a);
		expect(gate).toMatchObject({
			enabled: false,
			code: "not_verified",
			short: "not verified",
			fix: "Only a run that settled verified can win; request a repair or another attempt.",
		});
	});

	test("an accepted attempt is enabled, whatever else the table shows", () => {
		expect(selectGate(group(), attempt("A1")).enabled).toBe(true);
	});

	test("a server refusal the client has no wording for still disables, with the server's message", () => {
		const a = attempt("A1", {
			select: reject("future_rule", "a rule the UI does not know", "do x"),
		});
		const gate = selectGate(group(), a);
		expect(gate.enabled).toBe(false);
		expect(gate.message).toBe("a rule the UI does not know");
		expect(gate.fix).toBe("do x");
	});
});

describe("group helpers", () => {
	test("liveAttemptIds are the attempts with a process", () => {
		const g = group({
			attempts: [
				attempt("A1", { state: "running" }),
				attempt("A2", { state: "completed" }),
				attempt("A3", { state: "finalizing" }),
				attempt("A4", { state: "merging" }),
			],
		});
		expect(liveAttemptIds(g)).toEqual(["A1", "A3"]);
	});

	test("diffTotals sums the files", () => {
		expect(
			diffTotals([
				{ added: 3, removed: 1 },
				{ added: 0, removed: 4 },
			]),
		).toEqual({ added: 3, removed: 5, files: 2 });
	});
});

function render(node: ReturnType<typeof createElement>) {
	const queryClient = new QueryClient();
	const client = createTRPCClient<AppRouter>({ links: [] });
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(TRPCProvider, {
				trpcClient: client,
				queryClient,
				// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
				children: createElement(ToastProvider, null, node),
			}),
		),
	);
}

describe("GroupCompareView", () => {
	const view = (g: GroupData) =>
		render(createElement(GroupCompareView, { project: "alpha", group: g }));

	test("one column per attempt with the comparison rows", () => {
		const html = view(group());
		expect(html).toContain("Competing attempts");
		for (const label of [
			"Route",
			"State",
			"Duration",
			"Cost",
			"Verify",
			"Scope",
			"Review",
			"Changes",
			"Last message",
		]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("T-1#A1");
		expect(html).toContain("T-1#A2");
		expect(html).toContain("A1 says it is done");
		expect(html).toContain("The brain will select");
		expect(html).toContain("Add attempt");
	});

	test("Select winner is enabled only for the attempt the server would accept, and the refusal is shown", () => {
		const html = view(
			group({
				attempts: [
					attempt("A1"),
					attempt(
						"A2",
						{
							select: reject(
								"scope_outside",
								"A2 changed files outside its task's scope",
								"Scope violations go to review, never straight to merge.",
							),
						},
						{ scopeOutside: 1 },
					),
				],
			}),
		);
		const button = (id: string) => {
			const at = html.indexOf(`data-testid="select-${id}"`);
			const open = html.lastIndexOf("<button", at);
			return html.slice(open, html.indexOf(">", at));
		};
		expect(button("A1")).not.toContain('disabled=""');
		expect(button("A2")).toContain('disabled=""');
		expect(html).toContain('data-testid="blocked-A2"');
		expect(html).toContain("changed files outside its scope");
		expect(html).toContain(
			"Scope violations go to review, never straight to merge.",
		);
		expect(html).not.toContain('data-testid="blocked-A1"');
	});

	test("a decided group stars the winner, disables the rest and says who chose", () => {
		const html = view(
			group({
				status: "selecting",
				winnerRunId: "A1",
				selectedBy: {
					decisionId: 9,
					role: "human",
					reason: "cleaner diff",
					at: T0,
					runId: "A1",
				},
				attempts: [
					attempt("A1", { winner: true }),
					attempt("A2", {
						select: reject(
							"group_closed",
							"group G1 is selecting (winner A1)",
							"A group has at most one winner.",
						),
					}),
				],
			}),
		);
		expect(html).toContain('data-testid="winner"');
		expect(html).toContain("You selected");
		expect(html).toContain("cleaner diff");
		expect(html).toContain("winner chosen, merging");
		// a decided group offers no more attempts
		expect(html).not.toContain("Add attempt…");
		expect(html).toContain('data-testid="blocked-A2"');
	});

	test("a brain decision is attributed to the brain", () => {
		const html = view(
			group({
				status: "selecting",
				winnerRunId: "A2",
				selectedBy: {
					decisionId: 4,
					role: "brain",
					reason: "smaller change",
					at: T0,
					runId: "A2",
				},
				attempts: [attempt("A1"), attempt("A2", { winner: true })],
			}),
		);
		expect(html).toContain("The brain selected");
	});

	test("live attempts offer Stop all", () => {
		const html = view(
			group({
				attempts: [
					attempt("A1", { state: "running", finishedAt: null }),
					attempt("A2"),
				],
			}),
		);
		expect(html).toContain("Stop all");
	});
});

describe("DiffView for the compare columns", () => {
	const file: ReviewFile = {
		path: "src/a.ts",
		status: "modified",
		oldText: "one\ntwo\n",
		newText: "one\nthree\n",
		binary: false,
	};
	const draw = (extra: { readOnly?: boolean }) =>
		render(
			createElement(DiffView, {
				file,
				comments: [],
				unified: true,
				onAdd: () => {},
				onResolve: () => {},
				onRemove: () => {},
				...extra,
			}),
		);

	test("a read-only diff has no line to comment on", () => {
		const editable = draw({});
		const readOnly = draw({ readOnly: true });
		expect(editable).toContain('aria-label="Comment on line');
		expect(editable).not.toContain('disabled=""');
		expect(readOnly).toContain('disabled=""');
		// the diff itself is the same
		expect(readOnly).toContain("three");
	});
});
