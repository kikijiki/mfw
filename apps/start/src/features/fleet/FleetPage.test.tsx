import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RouterOutputs } from "../../lib/trpc";
import { FleetView, OccupantChip } from "./FleetPage";
import {
	budgetMeter,
	chipLook,
	chipTarget,
	slotMeter,
	unavailableLabel,
} from "./fleetModel";

type Fleet = RouterOutputs["fleet"]["summary"];
type Chip = Fleet["hosts"][number]["occupants"][number];

const NOW = Date.UTC(2027, 0, 20, 12, 0, 0);

function chip(over: Partial<Chip> & { runId: string }): Chip {
	return {
		ref: `run:${over.runId}`,
		project: "mfw",
		taskId: "MFW-41",
		taskTitle: null,
		label: null,
		kind: "task",
		state: "running",
		activity: "working",
		harness: "claude-cli",
		model: "opus",
		startedAt: NOW - 1000,
		liveCostUsd: null,
		...over,
	};
}

const health = {
	state: "ok",
	detail: null,
	checkedAt: null,
	items: [],
} as const;
const spend = { since: 0, usd: 1.5, tokens: 1200 };

function summary(): Fleet {
	return {
		generatedAt: NOW,
		liveRuns: 3,
		budgets: [],
		hosts: [
			{
				id: "local",
				kind: "local",
				label: "This machine",
				capacity: null,
				inUse: null,
				schedulable: true,
				reason: null,
				slots: [],
				occupants: [
					chip({ runId: "01A" }),
					chip({ runId: "01B", project: "jev", taskId: "JEV-12" }),
				],
				budgets: [],
				spend,
				hold: null,
				unavailableUntil: null,
				health,
			},
			{
				id: "box",
				kind: "ssh",
				label: "box",
				capacity: 2,
				inUse: 2,
				schedulable: true,
				reason: null,
				slots: [],
				occupants: [
					chip({ runId: "01C", activity: "needs_answer" }),
					chip({ runId: "01LEASE", project: null, state: "unknown" }),
				],
				budgets: [],
				spend,
				hold: null,
				unavailableUntil: null,
				health,
			},
		],
		accounts: [
			{
				key: "codex-cli@or",
				harness: "codex-cli",
				endpoint: "or",
				models: [],
				occupants: [],
				budgets: [
					{
						id: "agent:codex-cli@or",
						key: "codex-cli@or",
						kind: "agent",
						scope: "machine",
						project: null,
						unit: "usd",
						window: "day",
						limit: 30,
						used: 30,
						fraction: 1,
						warnAt: null,
						phase: "exhausted",
						held: true,
						windowStart: 0,
						resetsAt: NOW + 14 * 60_000,
					},
				],
				spend,
				hold: {
					source: "budget",
					reason: "budget exhausted: agent:codex-cli@or",
					until: NOW + 14 * 60_000,
					since: NOW - 1000,
				},
				unavailableUntil: NOW + 14 * 60_000,
				health: {
					state: "unavailable",
					detail: "held",
					checkedAt: null,
					items: [],
				},
			},
		],
		resources: [],
	} as unknown as Fleet;
}

describe("OccupantChip", () => {
	test("shows the agent state and opens the run's node in its own project", () => {
		const go: string[] = [];
		const html = renderToStaticMarkup(
			<OccupantChip
				chip={chip({ runId: "01B", project: "jev", taskId: "JEV-12" })}
				onNavigate={(to) => go.push(to)}
			/>,
		);
		expect(html).toContain('data-run-chip="01B"');
		expect(html).toContain('data-target="/p/jev/flow?node=run:01B"');
		expect(html).toContain('aria-label="working"');
		expect(html).toContain("JEV-12");
		expect(chipTarget({ project: "jev", runId: "01B" })).toBe(
			"/p/jev/flow?node=run:01B",
		);
	});

	test("an agent that needs an answer shows that state, not 'running'", () => {
		expect(
			chipLook({ state: "running", activity: "needs_answer" })?.label,
		).toBe("needs answer");
	});

	test("a lease no project owns is not a link", () => {
		const html = renderToStaticMarkup(
			<OccupantChip
				chip={chip({ runId: "01LEASE", project: null, state: "unknown" })}
				onNavigate={() => {}}
			/>,
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain('data-run-chip="01LEASE"');
		expect(chipTarget({ project: null, runId: "01LEASE" })).toBeNull();
	});
});

describe("FleetView", () => {
	const html = renderToStaticMarkup(
		<FleetView
			summary={summary()}
			now={NOW}
			onNavigate={() => {}}
			timeZone="UTC"
		/>,
	);

	test("every run on a host is a chip that selects its node", () => {
		for (const id of ["01A", "01B", "01C"]) {
			expect(html).toContain(`data-run-chip="${id}"`);
		}
		expect(html).toContain('data-target="/p/mfw/flow?node=run:01A"');
		expect(html).toContain('data-target="/p/jev/flow?node=run:01B"');
		// Slot usage reads as a meter next to the SSH host.
		expect(html).toContain('aria-label="2/2"');
	});

	test("a held account says when it is available again, and its budget is a full meter", () => {
		expect(html).toContain("unavailable until 12:14 (in 14m)");
		expect(html).toContain('data-budget="agent:codex-cli@or"');
		expect(html).toContain("$30.00 / $30.00 day");
		expect(html).toContain("exhausted");
	});
});

describe("fleetModel", () => {
	test("a hold with no reset time does not promise one", () => {
		expect(
			unavailableLabel(
				{ source: "paused", reason: "dispatch paused", until: null },
				NOW,
			),
		).toBe("held: dispatch paused");
		expect(
			unavailableLabel(
				{ source: "provider", reason: "rate_limit", until: NOW - 1 },
				NOW,
			),
		).toBeNull();
		expect(unavailableLabel(null, NOW)).toBeNull();
	});

	test("meters follow the budget's phase and cap at full", () => {
		const base = {
			id: "x",
			key: "x",
			kind: "agent",
			scope: "machine",
			project: null,
			unit: "usd",
			window: "day",
			limit: 10,
			warnAt: null,
			held: false,
			windowStart: 0,
			resetsAt: 1,
		} as const;
		expect(
			budgetMeter({ ...base, used: 4, fraction: 0.4, phase: "ok" }),
		).toEqual({ pct: 40, label: "$4.00 / $10.00 day", tone: "ok" });
		expect(
			budgetMeter({ ...base, used: 15, fraction: 1.5, phase: "exhausted" }),
		).toMatchObject({ pct: 100, tone: "critical" });
		expect(slotMeter(2, 2)).toEqual({ pct: 100, label: "2/2", tone: "warn" });
	});
});
