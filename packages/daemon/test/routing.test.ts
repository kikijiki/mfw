import { describe, expect, test } from "bun:test";
import { codexEndpointArgs } from "../src/agents/adapter.ts";
import type { HostCandidate } from "../src/host-registry.ts";
import {
	type PlacementRule,
	placeRun,
	type RouteInput,
	RoutingError,
	type RoutingSettings,
	routeRun,
	validateRoutingConfig,
} from "../src/routing.ts";

const CLAUDE = { id: "claude-cli", type: "claude-cli" as const };
const CODEX = { id: "codex-cli", type: "codex-cli" as const };

const settings = (over: Partial<RoutingSettings> = {}): RoutingSettings => ({
	provider: CLAUDE,
	model: "sonnet",
	reasoningEffort: "medium",
	...over,
});

const task = (
	over: Partial<NonNullable<RouteInput["task"]>> = {},
): NonNullable<RouteInput["task"]> => ({
	provider: null,
	model: null,
	modelTier: null,
	...over,
});

const LOCAL = {
	endpoints: {
		local: {
			baseUrl: "http://127.0.0.1:8080/v1",
			model: "qwen3-coder",
			vendor: "local",
		},
	},
};

describe("routeRun precedence: explicit > task > project tier map > catalogue", () => {
	const rows: {
		name: string;
		input: Omit<RouteInput, "kind">;
		expect: { provider: string; model: string; reason: string };
	}[] = [
		{
			name: "explicit model beats the task model and tier",
			input: {
				explicit: { model: "opus" },
				task: task({ model: "haiku", modelTier: "light" }),
				settings: settings({ modelTiers: { light: "claude-haiku-4-5" } }),
			},
			expect: { provider: "claude-cli", model: "opus", reason: "explicit" },
		},
		{
			name: "explicit provider beats the task provider",
			input: {
				explicit: { provider: "claude-cli" },
				task: task({ provider: "codex-cli" }),
				settings: settings(),
			},
			expect: { provider: "claude-cli", model: "sonnet", reason: "explicit" },
		},
		{
			name: "task model beats the project tier map",
			input: {
				task: task({ model: "haiku", modelTier: "strong" }),
				settings: settings({ modelTiers: { strong: "claude-opus-5" } }),
			},
			expect: { provider: "claude-cli", model: "haiku", reason: "task" },
		},
		{
			name: "task provider (no model) takes that provider's catalogue tier model",
			input: {
				task: task({ provider: "codex-cli", modelTier: "light" }),
				settings: settings({ modelTiers: { light: "claude-haiku-4-5" } }),
			},
			expect: { provider: "codex-cli", model: "gpt-5.6-luna", reason: "task" },
		},
		{
			name: "task provider with no tier takes that provider's default model",
			input: { task: task({ provider: "codex-cli" }), settings: settings() },
			expect: { provider: "codex-cli", model: "gpt-5.6-sol", reason: "task" },
		},
		{
			name: "task endpoint routes Codex to the endpoint's default model",
			input: {
				task: task({ provider: "local" }),
				settings: settings({ routing: LOCAL }),
			},
			expect: { provider: "codex-cli", model: "qwen3-coder", reason: "task" },
		},
		{
			name: "project tier map beats the catalogue",
			input: {
				task: task({ modelTier: "strong" }),
				settings: settings({ modelTiers: { strong: "claude-opus-5" } }),
			},
			expect: {
				provider: "claude-cli",
				model: "claude-opus-5",
				reason: "project-tier",
			},
		},
		{
			name: "standard tier without an override is the project model, not the catalogue",
			input: {
				task: task({ modelTier: "standard" }),
				settings: settings({ model: "claude-sonnet-5" }),
			},
			expect: {
				provider: "claude-cli",
				model: "claude-sonnet-5",
				reason: "project-model-standard",
			},
		},
		{
			name: "light tier without an override is the catalogue tier model",
			input: { task: task({ modelTier: "light" }), settings: settings() },
			expect: {
				provider: "claude-cli",
				model: "haiku",
				reason: "catalogue-tier",
			},
		},
		{
			name: "codex project light tier is the codex catalogue tier",
			input: {
				task: task({ modelTier: "light" }),
				settings: settings({ provider: CODEX, model: "gpt-5.6-sol" }),
			},
			expect: {
				provider: "codex-cli",
				model: "gpt-5.6-luna",
				reason: "catalogue-tier",
			},
		},
		{
			name: "no tier, no task fields: the project model",
			input: { task: task(), settings: settings() },
			expect: {
				provider: "claude-cli",
				model: "sonnet",
				reason: "project-model",
			},
		},
		{
			name: "a project routed to an endpoint uses the project model on it",
			input: {
				task: task({ modelTier: "light" }),
				settings: settings({
					provider: {
						...CODEX,
						endpoint: { id: "local", baseUrl: "http://127.0.0.1:8080/v1" },
					},
					model: "qwen3-coder",
					routing: LOCAL,
				}),
			},
			expect: {
				provider: "codex-cli",
				model: "qwen3-coder",
				reason: "project-model",
			},
		},
	];
	for (const row of rows) {
		test(row.name, () => {
			const d = routeRun({ kind: "task", ...row.input });
			const got = {
				provider: d.provider,
				model: d.model,
				reason: `${d.reason}`,
			};
			expect(got).toEqual(row.expect);
		});
	}

	test("effort: explicit, else the project's, else medium", () => {
		expect(
			routeRun({
				kind: "task",
				explicit: { effort: "high" },
				settings: settings(),
			}).effort,
		).toBe("high");
		expect(
			routeRun({
				kind: "task",
				settings: settings({ reasoningEffort: "low" }),
			}).effort,
		).toBe("low");
		expect(
			routeRun({
				kind: "task",
				settings: { provider: CLAUDE, model: "sonnet" },
			}).effort,
		).toBe("medium");
	});

	test("an unknown task provider refuses early with the fix", () => {
		expect(() =>
			routeRun({
				kind: "task",
				task: task({ provider: "gemini-cli" }),
				settings: settings({ routing: LOCAL }),
			}),
		).toThrow(/not something mfw can run.*endpoint \(local\)/);
	});
});

describe("routeRun holds and fallbacks", () => {
	const held = (keys: string[]) => (key: string) =>
		keys.includes(key)
			? { until: Date.now() + 60_000, reason: "rate limited" }
			: null;
	const fallbacks = {
		fallbacks: {
			default: [{ provider: "codex-cli" }, { provider: "local" }],
		},
		...LOCAL,
	};

	test("a held primary falls back down the chain, recording what it tried", () => {
		const d = routeRun({
			kind: "task",
			task: task(),
			settings: settings({ routing: fallbacks }),
			held: held(["claude-cli"]),
		});
		expect(d.provider).toBe("codex-cli");
		expect(d.model).toBe("gpt-5.6-sol");
		expect(d.reason).toBe("fallback");
		expect(d.held).toBeNull();
		expect(d.candidates.map((c) => c.holdKey)).toEqual([
			"claude-cli",
			"codex-cli",
			"codex-cli@local",
		]);
		expect(d.candidates[0]?.held?.reason).toBe("rate limited");
	});

	test("every candidate held: the decision is held on the primary", () => {
		const d = routeRun({
			kind: "task",
			settings: settings({ routing: fallbacks }),
			held: held(["claude-cli", "codex-cli", "codex-cli@local"]),
		});
		expect(d.held?.key).toBe("claude-cli");
		expect(d.provider).toBe("claude-cli");
	});

	test("a pinned task route never falls back: it waits", () => {
		const d = routeRun({
			kind: "task",
			task: task({ provider: "claude-cli" }),
			settings: settings({ routing: fallbacks }),
			held: held(["claude-cli"]),
		});
		expect(d.held?.key).toBe("claude-cli");
		expect(d.candidates).toHaveLength(1);
	});

	test("an explicit start ignores holds (a human overrides queue policy)", () => {
		const d = routeRun({
			kind: "task",
			explicit: { model: "opus" },
			settings: settings({ routing: fallbacks }),
			held: held(["claude-cli"]),
		});
		expect(d.held).toBeNull();
		expect(d.model).toBe("opus");
	});

	test("a Claude hold does not hold a Codex-routed task", () => {
		const d = routeRun({
			kind: "task",
			task: task({ provider: "codex-cli" }),
			settings: settings(),
			held: held(["claude-cli"]),
		});
		expect(d.held).toBeNull();
		expect(d.provider).toBe("codex-cli");
	});

	test("priors reorder fallbacks only when every fallback has a usable prior, never the primary", () => {
		const prior =
			(usable: boolean) => (c: { harness: string; model: string }) => ({
				n: usable ? 20 : 3,
				firstPassRate: c.model === "qwen3-coder" ? 0.9 : 0.2,
				usable,
			});
		const usable = routeRun({
			kind: "task",
			settings: settings({ routing: fallbacks }),
			held: held(["claude-cli"]),
			prior: prior(true),
		});
		expect(usable.candidates[0]?.holdKey).toBe("claude-cli");
		expect(usable.holdKey).toBe("codex-cli@local");
		const thin = routeRun({
			kind: "task",
			settings: settings({ routing: fallbacks }),
			held: held(["claude-cli"]),
			prior: prior(false),
		});
		expect(thin.holdKey).toBe("codex-cli");
		// Not held: the primary is chosen whatever the priors say.
		const free = routeRun({
			kind: "task",
			settings: settings({ routing: fallbacks }),
			prior: prior(true),
		});
		expect(free.holdKey).toBe("claude-cli");
	});
});

describe("routeRun continuations", () => {
	const parent = {
		provider: "claude-cli",
		endpoint: null,
		model: "haiku",
		effort: "medium" as const,
		tier: "light" as const,
		reason: "catalogue-tier" as const,
	};

	test("repairs inherit the parent route", () => {
		const d = routeRun({
			kind: "repair",
			parent,
			repairOrdinal: 2,
			settings: settings({ provider: CODEX }),
		});
		expect(d).toMatchObject({
			provider: "claude-cli",
			model: "haiku",
			reason: "inherited",
		});
	});

	test("escalateOnRepair moves repair 2 one tier up, not repair 1", () => {
		const s = settings({ routing: { escalateOnRepair: true } });
		expect(
			routeRun({ kind: "repair", parent, repairOrdinal: 1, settings: s }).model,
		).toBe("haiku");
		const d = routeRun({
			kind: "repair",
			parent,
			repairOrdinal: 2,
			settings: s,
		});
		expect(d).toMatchObject({
			model: "sonnet",
			tier: "standard",
			reason: "escalated",
			escalatedFrom: "haiku",
		});
	});

	test("a task-pinned model is never escalated", () => {
		const d = routeRun({
			kind: "repair",
			parent: { ...parent, reason: "task" },
			repairOrdinal: 3,
			settings: settings({ routing: { escalateOnRepair: true } }),
		});
		expect(d.reason).toBe("inherited");
	});
});

describe("routing config", () => {
	test("keys reach agents only through grants: envKey without grant is refused", () => {
		expect(() =>
			validateRoutingConfig({
				endpoints: {
					or: {
						baseUrl: "https://openrouter.ai/api/v1",
						envKey: "OPENROUTER_API_KEY",
					},
				},
			}),
		).toThrow(RoutingError);
		expect(() =>
			validateRoutingConfig({
				endpoints: { x: { baseUrl: "http://user:pw@host/v1" } },
			}),
		).toThrow(/credentials/);
		expect(() =>
			validateRoutingConfig({
				endpoints: { "codex-cli": { baseUrl: "http://h/v1" } },
			}),
		).toThrow(/collides/);
	});

	test("Codex gets the endpoint as a responses-wire model provider, key by env name only", () => {
		const args = codexEndpointArgs({
			id: "or",
			baseUrl: "https://openrouter.ai/api/v1",
			envKey: "OPENROUTER_API_KEY",
		});
		expect(args).toEqual([
			"-c",
			'model_provider="mfw-or"',
			"-c",
			'model_providers.mfw-or={ name = "mfw or", base_url = "https://openrouter.ai/api/v1", wire_api = "responses", env_key = "OPENROUTER_API_KEY" }',
		]);
	});
});

describe("placeRun precedence: task pin > project placement > local", () => {
	const host = (
		id: string,
		over: Partial<HostCandidate> = {},
	): HostCandidate => ({
		id,
		labels: [],
		harnesses: ["claude-cli"],
		slots: 1,
		schedulable: true,
		reason: null,
		...over,
	});
	const hosts = [
		host("box-a", { labels: ["gpu"] }),
		host("box-b", { harnesses: ["claude-cli", "codex-cli"] }),
		host("box-c", { schedulable: false, reason: "is refused: sudo" }),
	];
	const project = { target: "ssh" as const, labels: ["gpu"] };

	const rows: {
		name: string;
		taskTarget: string;
		placement?: { target: "local" | "ssh"; host?: string; labels?: string[] };
		harness?: string;
		free?: Record<string, number>;
		expect: { target: string; hostId: string | null; rule: PlacementRule };
	}[] = [
		{
			name: "no task pin and no project placement runs locally",
			taskTarget: "local",
			expect: { target: "local", hostId: null, rule: "default" },
		},
		{
			name: "project placement applies to a task that does not say",
			taskTarget: "local",
			placement: project,
			expect: { target: "ssh", hostId: "box-a", rule: "project" },
		},
		{
			name: "a task host pin beats the project placement",
			taskTarget: "ssh:box-b",
			placement: project,
			expect: { target: "ssh", hostId: "box-b", rule: "task" },
		},
		{
			name: "a task runpod pin beats an ssh project placement",
			taskTarget: "runpod",
			placement: project,
			expect: { target: "runpod", hostId: null, rule: "task" },
		},
		{
			name: "task 'ssh' with a local project picks any capable host",
			taskTarget: "ssh",
			harness: "codex-cli",
			expect: { target: "ssh", hostId: "box-b", rule: "task" },
		},
		{
			name: "matching hosts are ordered by free slots, then id",
			taskTarget: "ssh",
			free: { "box-a": 0, "box-b": 1 },
			expect: { target: "ssh", hostId: "box-b", rule: "task" },
		},
		{
			name: "with every host full the choice is stable (FIFO stays on one host)",
			taskTarget: "ssh",
			free: { "box-a": 0, "box-b": 0 },
			expect: { target: "ssh", hostId: "box-a", rule: "task" },
		},
	];
	for (const row of rows) {
		test(row.name, () => {
			const placed = placeRun({
				taskTarget: row.taskTarget,
				placement: row.placement ?? null,
				hosts,
				harness: row.harness ?? "claude-cli",
				...(row.free ? { free: (id: string) => row.free?.[id] ?? 0 } : {}),
			});
			expect({
				target: placed.target,
				hostId: placed.hostId,
				rule: placed.rule,
			}).toEqual(row.expect);
		});
	}

	test("refuses, with the reason, instead of placing on an unusable host", () => {
		expect(() =>
			placeRun({ taskTarget: "ssh:box-c", hosts, harness: "claude-cli" }),
		).toThrow("is refused: sudo");
		expect(() =>
			placeRun({ taskTarget: "ssh:box-a", hosts, harness: "codex-cli" }),
		).toThrow("cannot run codex-cli");
		expect(() =>
			placeRun({ taskTarget: "ssh:nope", hosts, harness: "claude-cli" }),
		).toThrow("not registered");
		expect(() =>
			placeRun({
				taskTarget: "local",
				placement: { target: "ssh", labels: ["tpu"] },
				hosts,
				harness: "claude-cli",
			}),
		).toThrow("labelled tpu");
	});

	test("routeRun records the host and refuses or skips harnesses the host lacks", () => {
		const onBoxA = {
			target: "ssh",
			hostId: "box-a",
			harnesses: ["claude-cli"],
		};
		const routed = routeRun({
			kind: "task",
			task: task(),
			settings: settings(),
			placement: onBoxA,
		});
		expect(routed).toMatchObject({ target: "ssh", hostId: "box-a" });
		expect(routed.detail).toContain("on host box-a");
		expect(() =>
			routeRun({
				kind: "task",
				task: task({ provider: "codex-cli" }),
				settings: settings(),
				placement: onBoxA,
			}),
		).toThrow("host 'box-a' cannot run codex-cli");
		// A project primary the host cannot run falls back to one it can.
		const fellBack = routeRun({
			kind: "task",
			task: task(),
			settings: settings({
				provider: CODEX,
				model: "gpt-5",
				routing: { fallbacks: { default: [{ provider: "claude-cli" }] } },
			}),
			placement: { ...onBoxA, harnesses: ["claude-cli"] },
		});
		expect(fellBack.provider).toBe("claude-cli");
	});
});
