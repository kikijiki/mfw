import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import { recordSpend } from "@mfw/db/spend";
import { createCaller } from "../src/root.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function row(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		kind: "task",
		state: "running",
		label: null,
		model: "opus",
		providerId: "claude-cli",
		harness: "claude-cli",
		modelVendor: "anthropic",
		routing: null,
		hostId: null,
		reasoningEffort: null,
		taskId: "MFW-1",
		attempt: 1,
		activity: "working",
		activityDetail: null,
		scopeSample: null,
		capabilities: { verified: false, steer: false },
		usageLive: { costUsd: 0.5 },
		startedAt: new Date(Date.now() - 60_000),
		...over,
	};
}

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-api-fleet-"));
	dirs.push(dir);
	const handle = await openProjectDb(join(dir, ".mfw"));
	await recordSpend(handle.db, {
		kind: "agent",
		accountKey: "claude-cli",
		source: "run_usage",
		runId: "old",
		usd: 2.25,
		tokensIn: 1000,
		tokensOut: 500,
	});
	const rows = [
		row("r1"),
		row("r2", { hostId: "box" }),
		row("r3", { kind: "brain" }),
	];
	const svc = {
		name: "alpha",
		handle,
		registry: {
			list: async () => rows,
			get: async (id: string) =>
				id === "r4" ? row("r4", { state: "completed", hostId: "box" }) : null,
		},
		tasks: { titles: () => new Map([["MFW-1", "A task"]]) },
		budgets: {
			list: async () => [
				{
					id: "agent:claude-cli",
					key: "claude-cli",
					kind: "agent",
					scope: "machine",
					window: "day",
					unit: "usd",
					limit: 10,
					warnAt: null,
					liveRunPolicy: "stop",
					used: 2.25,
					fraction: 0.225,
					windowStart: 0,
					windowResetsAt: 1,
					phase: "ok",
					held: false,
				},
			],
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		hosts: {
			list: async () => [
				{
					config: { id: "box", slots: 2 },
					observed: { checkedAt: 1, health: "ok", problems: [] },
					schedulable: true,
					reason: null,
					harnesses: [],
					slots: { resourceId: "remote.box.slots", capacity: 2, inUse: 1 },
				},
			],
		},
		hostResources: {
			readModel: () => ({
				definitions: [],
				effectiveCapacities: [],
				leases: [
					{
						id: "l1",
						state: "active",
						projectId: "p",
						run: { runId: "r4" },
						allocations: [{ resourceId: "remote.box.slots", amount: 1n }],
					},
				],
				health: [],
			}),
		},
		providerHolds: {
			active: async () => ({
				"codex-cli": { until: Date.now() + 60_000, reason: "rate_limit" },
			}),
		},
		runpod: {
			readModel: async () => ({
				enabled: false,
				accountId: "main",
				credential: {
					ready: false,
					checkedAt: 0,
					validatedAt: null,
					validationError: null,
				},
				gate: { open: false, reason: "closed", changedAt: 0 },
				settings: {
					version: 1,
					dispatchPaused: false,
					updatedAt: 0,
					updatedBy: "",
					reason: "",
				},
				inventory: {
					observedAt: null,
					cause: null,
					fresh: false,
					error: null,
					podCount: 0,
				},
				pods: [],
			}),
		},
		openrouter: {
			readModel: () => ({
				credential: { ready: false, validatedAt: null, validationError: null },
				checkedAt: null,
				fresh: false,
				error: null,
				key: null,
				credits: {
					available: false,
					reason: null,
					totalCredits: null,
					totalUsage: null,
					remainingCredits: null,
					error: null,
				},
			}),
		},
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), handle };
}

describe("fleet.summary", () => {
	test("occupants match runs.active and budgets and spend come from the ledger", async () => {
		const { api, handle } = await setup();
		const [active, fleet] = await Promise.all([
			api.runs.active(),
			api.fleet.summary(),
		]);
		const fleetRunIds = [
			...fleet.hosts.flatMap((h) => h.occupants.map((c) => c.runId)),
		].sort();
		// runs.active plus the host lease whose run the active listing lacks.
		expect(fleetRunIds).toEqual([...active.map((r) => r.runId), "r4"].sort());
		expect(
			fleet.hosts
				.find((h) => h.id === "box")
				?.occupants.find((c) => c.runId === "r4"),
		).toMatchObject({ project: "alpha", state: "completed" });
		expect(fleet.hosts.find((h) => h.id === "box")?.occupants[0]).toMatchObject(
			{ runId: "r2", ref: "run:r2", project: "alpha", state: "running" },
		);

		const acct = fleet.accounts.find((a) => a.key === "claude-cli");
		expect(acct?.spend.usd).toBe(2.25);
		expect(acct?.spend.tokens).toBe(1500);
		expect(acct?.budgets[0]).toMatchObject({ used: 2.25, limit: 10 });
		expect(acct?.occupants.map((c) => c.runId).sort()).toEqual(["r1", "r2"]);
		expect(acct?.occupants[0]?.liveCostUsd).toBe(0.5);

		const held = fleet.accounts.find((a) => a.key === "codex-cli");
		expect(held?.hold?.reason).toBe("rate_limit");
		expect(held?.unavailableUntil).toBeGreaterThan(Date.now());
		handle.close();
	});
});
