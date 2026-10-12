import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { EscalationsPanel, resolveProblem } from "./SessionCard";

function render(sessions: unknown[]) {
	const queryClient = new QueryClient();
	const client = createTRPCClient<AppRouter>({ links: [] });
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	queryClient.setQueryData(trpc.sessions.open.queryKey(), sessions as never);
	return renderToStaticMarkup(
		createElement(
			ToastProvider,
			null,
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(TRPCProvider, {
					trpcClient: client,
					queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: createElement(EscalationsPanel),
				}),
			),
		),
	);
}

const session = {
	project: "alpha",
	id: "01SESSION",
	source: "merge_parked",
	sourceKey: "job:7",
	taskId: null,
	runId: null,
	mergeJobId: 7,
	title: "Merge of MFW-9 parked after 3 attempts",
	context: "## What failed\n\n`bun test` exited 1",
	createdAt: new Date("2026-10-01T00:00:00Z"),
	openedRunId: null,
	openedAt: null,
	resolvedAt: null,
	resolution: null,
	resolutionReason: null,
};

describe("escalation sessions on NOW", () => {
	test("no open session renders nothing", () => {
		expect(render([])).toBe("");
	});

	test("an open brief shows what failed and how to act on it", () => {
		const html = render([session]);
		expect(html).toContain('aria-label="Escalations"');
		expect(html).toContain("Merge of MFW-9 parked after 3 attempts");
		expect(html).toContain("merge parked");
		expect(html).toContain("Start session");
		expect(html).toContain("Read the brief");
		for (const label of ["Fixed", "Retried", "Dismiss"])
			expect(html).toContain(`>${label}</button>`);
	});
});

describe("resolve rules mirror SessionService.resolve", () => {
	test("dismissing needs a reason; fixed and retried do not", () => {
		expect(resolveProblem("dismissed", "   ")).not.toBeNull();
		expect(resolveProblem("dismissed", "duplicate of MFW-3")).toBeNull();
		expect(resolveProblem("fixed", "")).toBeNull();
		expect(resolveProblem("retried", "")).toBeNull();
	});
});
