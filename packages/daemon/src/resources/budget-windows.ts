import { createHash } from "node:crypto";
import type { ProjectDbHandle } from "@mfw/db/client";
import { spendLedger } from "@mfw/db/schema";
import { and, eq, gte, like, lt } from "drizzle-orm";
import type { Dimension } from "../../../plugin-api/src/resource.ts";
import type { ResourceStore } from "./store.ts";

const DIMENSION = "spend";
/** Token counts are stored in thousands, so a month of tokens stays exact. */
const TOKENS_PER_UNIT = 1_000;
const UNIT_SECONDS = { m: 60, h: 3_600, d: 86_400 } as const;

export interface BudgetWindowRef {
	id: string;
	key: string;
	kind: "agent" | "resource" | "brain";
	scope: "project" | "machine";
	window: string;
	unit: "usd" | "tokens" | "slot_hours";
	limit: number;
}

type WindowSpec = Extract<Dimension, { kind: "window" }>["window"];

function windowSpec(window: string): WindowSpec {
	if (window === "day" || window === "week" || window === "month") {
		return { type: "calendar", period: window, tz: "UTC" };
	}
	if (window === "hour") return { type: "rolling", seconds: 3_600 };
	const match = /^([1-9][0-9]*)([mhd])$/.exec(window);
	if (!match) throw new Error(`invalid budget window '${window}'`);
	return {
		type: "rolling",
		seconds:
			Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS],
	};
}

function amountOf(
	unit: BudgetWindowRef["unit"],
	row: {
		usd: number | null;
		tokensIn: number | null;
		tokensOut: number | null;
	},
): number {
	if (unit === "usd") return row.usd ?? 0;
	if (unit === "tokens") {
		return ((row.tokensIn ?? 0) + (row.tokensOut ?? 0)) / TOKENS_PER_UNIT;
	}
	// Slot-time rows carry slot-seconds in `tokens_in`.
	return (row.tokensIn ?? 0) / 3_600;
}

/**
 * Budget usage as core windows. Each budget is a pool whose window holds a
 * settled charge per spend row, so a machine-wide total is one read and
 * survives a project being detached. Spend is recorded after the fact: no run
 * has a pre-run estimate to reserve against.
 */
export class BudgetWindows {
	private readonly defined = new Map<string, string>();
	/** Per budget and ledger, the rows last copied, to skip an unchanged pass. */
	private readonly copied = new Map<string, string>();

	constructor(private readonly store: ResourceStore) {}

	private poolIdOf(budget: BudgetWindowRef, project: string): string {
		const owner = budget.scope === "machine" ? "machine" : `project:${project}`;
		const hash = createHash("sha256")
			.update(`${owner}\0${budget.id}\0${budget.unit}\0${budget.window}`)
			.digest("hex")
			.slice(0, 24);
		return `budget.b${hash}`;
	}

	private async ensurePool(
		poolId: string,
		budget: BudgetWindowRef,
	): Promise<void> {
		const limit =
			budget.unit === "tokens" ? budget.limit / TOKENS_PER_UNIT : budget.limit;
		const signature = `${limit}`;
		if (this.defined.get(poolId) === signature) return;
		await this.store.definePool({
			id: poolId,
			title: `Budget ${budget.id}`,
			dimensions: [
				{
					kind: "window",
					name: DIMENSION,
					unit: budget.unit,
					limit,
					window: windowSpec(budget.window),
				},
			],
			providerHardLimit: false,
			maxObservationAgeMs: null,
		});
		this.defined.set(poolId, signature);
	}

	private async copyRows(
		poolId: string,
		budget: BudgetWindowRef,
		bounds: { start: number; end: number },
		handle: ProjectDbHandle,
		ledgerIndex: number,
		project: string,
	): Promise<void> {
		const rows = await handle.db
			.select({
				id: spendLedger.id,
				ts: spendLedger.ts,
				usd: spendLedger.usd,
				tokensIn: spendLedger.tokensIn,
				tokensOut: spendLedger.tokensOut,
			})
			.from(spendLedger)
			.where(
				and(
					gte(spendLedger.ts, new Date(bounds.start)),
					lt(spendLedger.ts, new Date(bounds.end)),
					budget.kind === "brain"
						? eq(spendLedger.kind, "brain")
						: budget.key.endsWith("*")
							? like(spendLedger.accountKey, `${budget.key.slice(0, -1)}%`)
							: eq(spendLedger.accountKey, budget.key),
					budget.unit === "slot_hours"
						? eq(spendLedger.source, "host_slot_time")
						: undefined,
				),
			);
		const charges = rows.map((row) => ({
			entryKey: `spend:${poolId}:${row.id}`,
			amount: amountOf(budget.unit, row),
			atMs: row.ts.getTime(),
		}));
		const memo = `${poolId}\0${ledgerIndex}\0${bounds.start}`;
		const signature = createHash("sha256")
			.update(JSON.stringify(charges))
			.digest("hex");
		if (this.copied.get(memo) === signature) return;
		await this.store.syncCharges({
			poolId,
			dimension: DIMENSION,
			projectId: budget.scope === "machine" ? "machine" : project,
			charges,
		});
		this.copied.set(memo, signature);
	}

	/** What this budget has used in the window, in the budget's own unit. */
	async measure(
		budget: BudgetWindowRef,
		bounds: { start: number; end: number },
		handles: readonly ProjectDbHandle[],
		project: string,
	): Promise<number> {
		const poolId = this.poolIdOf(budget, project);
		await this.ensurePool(poolId, budget);
		for (const [index, handle] of handles.entries()) {
			await this.copyRows(poolId, budget, bounds, handle, index, project);
		}
		const total = await this.store.windowTotal(
			poolId,
			DIMENSION,
			bounds.start,
			bounds.end,
		);
		return budget.unit === "tokens"
			? Math.round(total * TOKENS_PER_UNIT)
			: total;
	}
}
