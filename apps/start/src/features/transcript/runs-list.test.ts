import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { primaryLabel, runMetricValues } from "./RunsListPage";

/**
 * The runs list printed each task's id TWICE per row: `run.label` is set to the
 * task id by `RunEngine.startTask`, and the row rendered both the label and a
 * `<Mono value={run.taskId} />`. The duplicate also held the row's `flex-1`,
 * so a six-character id was stretched across the row while the task title,
 * the only part worth reading at a glance: was capped at `max-w-48`.
 */
describe("what a run row says", () => {
	const run = (over: Partial<Parameters<typeof primaryLabel>[0]> = {}) => ({
		id: "01M00W79CWSB445X7FA8XMWABT",
		label: "MFW-26",
		taskId: "MFW-26" as string | null,
		taskTitle: null as string | null,
		...over,
	});

	test("the flexible column NEVER repeats the id shown beside it", () => {
		// The invariant, stated directly: whatever this returns, it is not the
		// task id, because the id has its own column on the same row.
		for (const r of [
			run(),
			run({ taskTitle: "Overlay panel for tasks" }),
			run({ label: "MFW-26", taskTitle: null }),
		]) {
			expect(primaryLabel(r)).not.toBe(r.taskId);
		}
	});

	test("the title wins when there is one", () => {
		expect(primaryLabel(run({ taskTitle: "Overlay panel for tasks" }))).toBe(
			"Overlay panel for tasks",
		);
	});

	test("a titleless task run falls back to something the row does not show", () => {
		// Not the label, that is the id again. The run's own short id at least
		// distinguishes two runs of the same task.
		expect(primaryLabel(run())).toBe("A8XMWABT");
	});

	test("a non-task run keeps its own label", () => {
		expect(
			primaryLabel(run({ taskId: null, label: "import repository" })),
		).toBe("import repository");
	});

	test("a taskless run does not invent an empty task badge", () => {
		const src = readFileSync(join(import.meta.dir, "RunsListPage.tsx"), "utf8");
		expect(src).not.toContain("<span aria-hidden />");
		expect(src).toContain("{run.taskId ? (");
	});

	test("rows switch from one narrow column to stable desktop columns", () => {
		const src = readFileSync(join(import.meta.dir, "RunsListPage.tsx"), "utf8");
		const template = src.match(/lg:grid-cols-\[([^\]]+)\]/)?.[1];
		expect(template).toBe("minmax(0,1fr)_5.5rem_6.5rem_6.5rem");
		expect(src).toContain("grid min-w-0 grid-cols-1");
		expect(src).toContain("grid min-w-0 grid-cols-3");
		expect(src).toContain("lg:col-span-3");
		expect(src).toContain("flex-col items-start");
		expect(src).toContain("sm:flex-row sm:items-baseline");
		expect(src).toContain("<Duration");
		expect(src).toContain("<Tokens");
		expect(src).toContain("<Cost");
	});

	test("the responsive metrics group labels values in a stable order", () => {
		const src = readFileSync(join(import.meta.dir, "RunsListPage.tsx"), "utf8");
		const metrics = src.slice(src.indexOf("function RunMetrics"));
		expect(metrics).toContain('<dl\n\t\t\taria-label="Run metrics"');
		expect(metrics.indexOf(">Duration</dt>")).toBeLessThan(
			metrics.indexOf(">Tokens</dt>"),
		);
		expect(metrics.indexOf(">Tokens</dt>")).toBeLessThan(
			metrics.indexOf(">Cost</dt>"),
		);
	});

	test("present and missing usage keep all three metric cells", () => {
		const startedAt = new Date("2026-08-19T00:00:00Z");
		expect(
			runMetricValues({
				startedAt,
				finishedAt: new Date("2026-08-19T00:01:30Z"),
				usage: { inputTokens: 1200, outputTokens: 34, costUsd: 0.12 },
			}),
		).toEqual({ durationMs: 90_000, tokens: 1234, costUsd: 0.12 });
		expect(
			runMetricValues({ startedAt, finishedAt: null, usage: null }),
		).toEqual({ durationMs: null, tokens: null, costUsd: null });
	});

	test("the id is rendered once, and it is the task link", () => {
		// Guards the markup the helper exists to support: exactly one `Mono` of
		// the task id per row, and the flexible column is the title link.
		const src = readFileSync(join(import.meta.dir, "RunsListPage.tsx"), "utf8");
		expect(src.match(/<Mono value={run\.taskId}/g)?.length ?? 0).toBe(1);
		expect(src).toContain("{primaryLabel(run)}");
		// DOM order is also keyboard order: transcript first, optional task second.
		expect(src.indexOf("href.run(project, run.id)")).toBeLessThan(
			src.indexOf("href.task(project, run.taskId)"),
		);
	});

	test("the list asks for agent sessions and never invents a legacy provider", () => {
		const src = readFileSync(join(import.meta.dir, "RunsListPage.tsx"), "utf8");
		expect(src).toContain("includeInternal: false");
		expect(src).toContain("{run.providerId ? (");
		expect(src).not.toContain('?? "legacy"');
	});

	test("long identity and provider values are constrained to their row", () => {
		const src = readFileSync(join(import.meta.dir, "RunsListPage.tsx"), "utf8");
		expect(src).toContain('className="min-w-0 max-w-full truncate"');
		expect(src).toContain('className="block truncate"');
		expect(src).toContain("title={run.model}");
	});
});
