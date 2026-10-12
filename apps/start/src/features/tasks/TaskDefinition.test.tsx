import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";

// `useBlocker` needs a mounted router; the form's unsaved-changes guard is not under test here.
const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
	...realRouter,
	useBlocker: () => undefined,
}));
const { TaskDefinition } = await import("./TaskDefinition");

import.meta.env.BASE_URL ??= "/";

const task = {
	id: "T-1",
	title: "Parse v1 keys",
	body: "",
	type: "implementation",
	priority: "medium",
	size: null,
	labels: [],
	dependsOn: [],
	criteria: [],
	verification: null,
	requireReview: false,
	afterExpansion: "ready",
	owns: [],
	modelTier: null,
	provider: null,
	model: null,
	executionTarget: "local",
	reopenWhen: [],
	contentRev: 3,
	status: "ready",
	claimedByRunId: null,
	draftPhase: null,
	templateMissing: [],
	blockedReason: null,
} as never;

function render(layout: "flat" | "directory" | null): string {
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
				children: createElement(
					ToastProvider,
					null,
					createElement(TaskDefinition, {
						project: "alpha",
						taskId: "T-1",
						task,
						layout,
					}),
				),
			}),
		),
	);
}

describe("TaskDefinition", () => {
	test("a directory board shows the spec and attachments panels", () => {
		const html = render("directory");
		expect(html).toContain("Parse v1 keys");
		expect(html).toContain("Spec");
		expect(html).toContain("Attachments");
	});

	test("a flat board hides the spec and attachments panels, keeping the rest of the form", () => {
		const html = render("flat");
		expect(html).toContain("Parse v1 keys");
		expect(html).toContain("Acceptance criteria");
		expect(html).not.toContain(">Spec<");
		expect(html).not.toContain(">Attachments<");
	});

	test("until the board schema is known neither panel mounts (no spec fetch on a flat board)", () => {
		const html = render(null);
		expect(html).not.toContain(">Spec<");
		expect(html).not.toContain(">Attachments<");
	});

	test("the conflict bar and its two ways out are still on the form", () => {
		const src = readFileSync(
			join(import.meta.dir, "TaskDefinition.tsx"),
			"utf8",
		);
		expect(src).toContain('error.data?.code === "CONFLICT"');
		expect(src).toContain("Reload theirs");
		expect(src).toContain("Keep mine");
		expect(src).toContain("doSave(task.contentRev)");
	});
});

describe("the retired task panels", () => {
	const root = join(import.meta.dir, "..", "..");
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.tsx"))
				files.push(path);
		}
	};
	walk(root);

	test("no source file names the deleted run panel or reads the task trace", () => {
		// Spelled in pieces so this file does not itself match a grep for them.
		const banned = ["Task" + "RunPanel", "task" + "Trace"];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const word of banned) {
				expect(text.includes(word) ? `${file}: ${word}` : "").toBe("");
			}
		}
	});

	test("the task page has no Activity, Runs or Decisions panels", () => {
		const page = readFileSync(join(import.meta.dir, "TaskPage.tsx"), "utf8");
		const def = readFileSync(
			join(import.meta.dir, "TaskDefinition.tsx"),
			"utf8",
		);
		for (const title of ["Activity", "Runs", "Decisions"]) {
			expect(page).not.toContain(`<Panel title="${title}"`);
			expect(def).not.toContain(`<Panel title="${title}"`);
		}
	});

	test("the task page mounts the story, the definition and the review page", () => {
		const page = readFileSync(join(import.meta.dir, "TaskPage.tsx"), "utf8");
		expect(page).toContain("<TaskStory");
		expect(page).toContain("<TaskDefinition");
		expect(page).toContain("<ReviewPage");
		expect(page).toContain("trpc.board.schema.queryOptions");
	});
});
