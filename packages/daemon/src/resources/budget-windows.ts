import { createHash } from "node:crypto";
import type { ProjectDbHandle } from "@mfw/db/client";
import { REPORTED_SPEND_SOURCES } from "@mfw/db/provenance";
import { spendLedger } from "@mfw/db/schema";
import {
	and,
	eq,
	gte,
	inArray,
	like,
	lt,
	notInArray,
	type SQL,
} from "drizzle-orm";
import type { Dimension } from "../../../plugin-api/src/resource.ts";
import type { ResourceStore } from "./store.ts";

const DIMENSION = "spend";
/** Token counts are stored in thousands, so a month of tokens stays exact. */
const TOKENS_PER_UNIT = 1_000;
const UNIT_SECONDS = { m: 60, h: 3_600, d: 86_400 } as const;
/**
 * The largest amount the ledger stores exactly. A larger host figure saturates
 * here, so it exhausts the budget instead of failing the evaluation that
 * would have enforced it.
 */
const MAX_AMOUNT = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);

function storable(amount: number): number {
	return Math.max(0, Math.min(amount, MAX_AMOUNT));
}

/** `host` is what enforcement reads; `reported` is what agents claim. */
export type SpendBasis = "host" | "reported";

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
		const limit = storable(
			budget.unit === "tokens" ? budget.limit / TOKENS_PER_UNIT : budget.limit,
		);
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

	private rowsOf(
		budget: BudgetWindowRef,
		bounds: { start: number; end: number },
		basis: SpendBasis,
	): SQL | undefined {
		return and(
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
			basis === "host"
				? notInArray(spendLedger.source, [...REPORTED_SPEND_SOURCES])
				: inArray(spendLedger.source, [...REPORTED_SPEND_SOURCES]),
		);
	}

	/**
	 * What runs say about themselves, for display. It is sandbox-reported, so
	 * it is read from the project ledgers and never enters the core's windows.
	 */
	private async reportedTotal(
		budget: BudgetWindowRef,
		bounds: { start: number; end: number },
		handles: readonly ProjectDbHandle[],
	): Promise<number> {
		let total = 0;
		for (const handle of handles) {
			const rows = await handle.db
				.select({
					usd: spendLedger.usd,
					tokensIn: spendLedger.tokensIn,
					tokensOut: spendLedger.tokensOut,
				})
				.from(spendLedger)
				.where(this.rowsOf(budget, bounds, "reported"));
			for (const row of rows) total += amountOf(budget.unit, row);
		}
		return budget.unit === "tokens" ? total * TOKENS_PER_UNIT : total;
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
			.where(this.rowsOf(budget, bounds, "host"));
		const charges = rows.map((row) => ({
			entryKey: `spend:${poolId}:${row.id}`,
			amount: storable(amountOf(budget.unit, row)),
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
		basis: SpendBasis = "host",
	): Promise<number> {
		if (basis === "reported") {
			return this.reportedTotal(budget, bounds, handles);
		}
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
