import { describe, expect, test } from "bun:test";
import type { BudgetStatus } from "../src/budgets.ts";
import {
	buildFleetSummary,
	type FleetInputs,
	type FleetRunInput,
} from "../src/fleet.ts";

const NOW = Date.UTC(2027, 0, 20, 12, 0, 0);
const DAY = Date.UTC(2027, 0, 20);

function run(over: Partial<FleetRunInput> & { runId: string }): FleetRunInput {
	return {
		project: "mfw",
		kind: "task",
		state: "running",
		activity: "working",
		label: null,
		taskId: "MFW-1",
		taskTitle: "A task",
		providerId: "claude-cli",
		harness: "claude-cli",
		model: "opus",
		modelVendor: "anthropic",
		routing: null,
		hostId: null,
		startedAt: NOW - 60_000,
		liveCostUsd: null,
		...over,
	};
}

function budget(over: Partial<BudgetStatus>): BudgetStatus {
	return {
		id: "agent:claude-cli",
		key: "claude-cli",
		kind: "agent",
		scope: "machine",
		window: "day",
		unit: "usd",
		limit: 10,
		warnAt: null,
		liveRunPolicy: "stop",
		used: 4,
		fraction: 0.4,
		windowStart: DAY,
		windowResetsAt: DAY + 86_400_000,
		phase: "ok",
		held: false,
		...over,
	};
}

function host(id: string, inUse: number, health = "ok", capacity = 2) {
	return {
		config: { id, slots: capacity },
		observed: {
			checkedAt: NOW - 1000,
			health,
			problems: health === "ok" ? [] : ["timeout"],
		},
		schedulable: true,
		reason: null,
		harnesses: ["claude-cli"],
		slots: { resourceId: `remote.${id}.slots`, capacity, inUse },
	} as never;
}

function inputs(over: Partial<FleetInputs> = {}): FleetInputs {
	return {
		now: NOW,
		runs: [],
		sshHosts: [],
		hostModel: {
			definitions: [],
			effectiveCapacities: [],
			leases: [],
			health: [],
		},
		holds: {},
		budgets: [],
		spend: {},
		spendSince: DAY,
		runpod: {
			enabled: true,
			accountId: "main",
			credential: {
				ready: true,
				checkedAt: NOW,
				validatedAt: NOW,
				validationError: null,
			},
			gate: { open: true, reason: null, changedAt: NOW },
			settings: {
				version: 1,
				dispatchPaused: false,
				updatedAt: NOW,
				updatedBy: "x",
				reason: "",
				policy: {},
			},
			inventory: {
				observedAt: NOW,
				cause: null,
				fresh: true,
				error: null,
				podCount: 0,
			},
			pods: [],
		},
		openrouter: {
			credential: { ready: true, validatedAt: NOW, validationError: null },
			checkedAt: NOW,
			fresh: true,
			error: null,
			key: null,
			credits: {
				available: true,
				reason: null,
				totalCredits: 10,
				totalUsage: 4,
				remainingCredits: 6,
				error: null,
			},
		},
		...over,
	} as unknown as FleetInputs;
}

describe("buildFleetSummary", () => {
	test("occupants are the live runs plus host leases, each chip naming project and ref", () => {
		const s = buildFleetSummary(
			inputs({
				runs: [
					run({ runId: "r1" }),
					run({ runId: "r2", project: "jev", hostId: "box" }),
					run({ runId: "done", state: "completed" }),
					run({ runId: "brain", kind: "brain" }),
				],
				sshHosts: [host("box", 2)],
				hostModel: {
					definitions: [],
					effectiveCapacities: [],
					health: [],
					leases: [
						{
							id: "l1",
							state: "active",
							projectId: "p",
							run: { runId: "ghost" },
							allocations: [{ resourceId: "remote.box.slots", amount: 1n }],
						},
						{
							id: "l2",
							state: "released",
							projectId: "p",
							run: { runId: "old" },
							allocations: [{ resourceId: "remote.box.slots", amount: 1n }],
						},
					],
				} as never,
			}),
		);
		const local = s.hosts.find((h) => h.id === "local");
		const box = s.hosts.find((h) => h.id === "box");
		expect(local?.occupants.map((c) => c.runId)).toEqual(["r1"]);
		expect(local?.occupants[0]).toMatchObject({
			ref: "run:r1",
			project: "mfw",
			activity: "working",
		});
		// A registry row and a lease-only run; the released lease is not an occupant.
		expect(box?.occupants.map((c) => c.runId).sort()).toEqual(["ghost", "r2"]);
		expect(box?.occupants.find((c) => c.runId === "r2")?.project).toBe("jev");
		expect(box?.occupants.find((c) => c.runId === "ghost")?.project).toBeNull();
		expect(s.liveRuns).toBe(2);
	});

	test("an exhausted agent budget marks the account unavailable until the window resets", () => {
		const exhausted = budget({
			used: 10,
			fraction: 1,
			phase: "exhausted",
			held: true,
		});
		const s = buildFleetSummary(
			inputs({
				runs: [run({ runId: "r1" })],
				budgets: [
					{ project: "mfw", status: exhausted },
					// The same machine ceiling seen from a second project is one budget.
					{ project: "jev", status: exhausted },
				],
			}),
		);
		const acct = s.accounts.find((a) => a.key === "claude-cli");
		expect(acct?.unavailableUntil).toBe(DAY + 86_400_000);
		expect(acct?.hold?.source).toBe("budget");
		expect(acct?.health.state).toBe("unavailable");
		expect(acct?.budgets).toHaveLength(1);
		expect(s.budgets).toHaveLength(1);
		expect(s.budgets[0]?.project).toBeNull();
	});

	test("a provider rate-limit hold keeps an idle account on the page with its reset time", () => {
		const until = NOW + 14 * 60_000;
		const s = buildFleetSummary(
			inputs({
				holds: {
					"codex-cli@or": { until, reason: "rate_limit", since: NOW - 1 },
				},
			}),
		);
		const acct = s.accounts.find((a) => a.key === "codex-cli@or");
		expect(acct).toMatchObject({
			harness: "codex-cli",
			endpoint: "or",
			unavailableUntil: until,
		});
		expect(acct?.hold).toMatchObject({
			source: "provider",
			reason: "rate_limit",
		});
		expect(acct?.occupants).toEqual([]);
	});

	test("accounts group by route hold key and carry per-model live counts and ledger spend", () => {
		const s = buildFleetSummary(
			inputs({
				runs: [
					run({ runId: "a", model: "opus" }),
					run({ runId: "b", model: "opus" }),
					run({ runId: "c", model: "sonnet" }),
					run({
						runId: "d",
						providerId: "codex-cli",
						harness: "codex-cli",
						model: "gpt-5",
						routing: {
							provider: "codex-cli",
							holdKey: "codex-cli@or",
							model: "gpt-5",
						},
					}),
				],
				spend: {
					"claude-cli": { usd: 1.5, tokens: 100 },
					"codex-cli@or": { usd: 0.25, tokens: 10 },
				},
			}),
		);
		const claude = s.accounts.find((a) => a.key === "claude-cli");
		expect(claude?.models.map((m) => [m.model, m.live])).toEqual([
			["opus", 2],
			["sonnet", 1],
		]);
		expect(claude?.spend).toEqual({ since: DAY, usd: 1.5, tokens: 100 });
		expect(
			s.accounts.find((a) => a.key === "codex-cli@or")?.occupants,
		).toHaveLength(1);
	});

	test("RunPod pods carry their run as an occupant, and a paused account is held with no reset time", () => {
		const base = inputs({
			runs: [run({ runId: "p1" })],
			budgets: [
				{
					project: "mfw",
					status: budget({
						id: "resource:runpod:main",
						key: "runpod:main",
						kind: "resource",
						limit: 200,
						used: 142,
						fraction: 0.71,
						window: "month",
					}),
				},
			],
		});
		const withPod = {
			...base,
			runpod: {
				...base.runpod,
				pods: [
					{
						podId: "pod1",
						name: "mfw-run",
						live: true,
						phase: "running",
						costPerHr: 0.7,
						runId: "p1",
						projectName: "mfw",
					},
				],
				settings: {
					...base.runpod.settings,
					dispatchPaused: true,
					reason: "ops",
				},
			},
		} as FleetInputs;
		const s = buildFleetSummary(withPod);
		const rp = s.resources.find((r) => r.kind === "runpod");
		expect(rp?.occupants.map((c) => c.runId)).toEqual(["p1"]);
		expect(rp?.budgets[0]?.fraction).toBe(0.71);
		expect(rp?.hold).toMatchObject({ source: "paused", until: null });
		// The pod's run is not also counted as running on this machine.
		expect(s.hosts.find((h) => h.id === "local")?.occupants).toEqual([]);
	});

	test("an unreachable SSH host is unavailable; OpenRouter lists its own vendor's runs", () => {
		const s = buildFleetSummary(
			inputs({
				sshHosts: [host("box", 0, "unreachable")],
				runs: [run({ runId: "o1", modelVendor: "openrouter" })],
			}),
		);
		expect(s.hosts.find((h) => h.id === "box")?.health).toMatchObject({
			state: "unavailable",
			detail: "timeout",
		});
		const or = s.resources.find((r) => r.kind === "openrouter");
		expect(or?.occupants.map((c) => c.runId)).toEqual(["o1"]);
		expect(or?.remainingCredits).toBe(6);
	});
});
