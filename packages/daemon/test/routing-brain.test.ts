import { describe, expect, test } from "bun:test";
import {
	type RouteInput,
	type RoutingSettings,
	routeRun,
} from "../src/routing.ts";

const CLAUDE = { id: "claude-cli", type: "claude-cli" as const };

const settings = (over: Partial<RoutingSettings> = {}): RoutingSettings => ({
	provider: CLAUDE,
	model: "sonnet",
	reasoningEffort: "medium",
	...over,
});

const input = (over: Partial<RouteInput>): RouteInput => ({
	kind: "task",
	settings: settings(),
	task: { provider: null, model: null, modelTier: null },
	...over,
});

describe("routeRun rule `brain` (design I14)", () => {
	test("the brain's pick routes the run, tagged with the rule", () => {
		const d = routeRun(
			input({
				brain: { provider: "codex-cli", model: "gpt-5.4", effort: "high" },
			}),
		);
		expect(d).toMatchObject({
			provider: "codex-cli",
			model: "gpt-5.4",
			effort: "high",
			reason: "brain",
		});
	});

	test("a human pin on the task wins over the brain", () => {
		const d = routeRun(
			input({
				task: { provider: null, model: "opus", modelTier: null },
				brain: { model: "haiku" },
			}),
		);
		expect(d).toMatchObject({ model: "opus", reason: "task" });
	});

	test("an explicit start option wins over the brain", () => {
		const d = routeRun(
			input({ explicit: { model: "opus" }, brain: { model: "haiku" } }),
		);
		expect(d).toMatchObject({ model: "opus", reason: "explicit" });
	});

	test("the brain overrides a human pin only with the audited flag", () => {
		const d = routeRun(
			input({
				task: { provider: null, model: "opus", modelTier: null },
				brain: { model: "haiku", overrideHumanPin: true },
			}),
		);
		expect(d).toMatchObject({ model: "haiku", reason: "brain" });
	});

	test("a brain pick is still subject to provider holds", () => {
		const d = routeRun(
			input({
				brain: { provider: "claude-cli", model: "haiku" },
				held: (key) =>
					key === "claude-cli"
						? { until: Date.now() + 60_000, reason: "rate limited" }
						: null,
			}),
		);
		expect(d.held).toMatchObject({ key: "claude-cli", reason: "rate limited" });
	});

	test("effort alone changes the effort, not the rule", () => {
		const d = routeRun(input({ brain: { effort: "high" } }));
		expect(d).toMatchObject({ effort: "high", reason: "project-model" });
	});
});
