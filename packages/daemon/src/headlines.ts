import type { ProjectDbHandle } from "@mfw/db/client";
import { events } from "@mfw/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import type { ReviewDebt } from "./act-budget.ts";
import type { ClaimClass } from "./claims.ts";
import type { InboxItem } from "./inbox.ts";
import { startOfLocalDay } from "./project-summary.ts";

/**
 * L2 mechanical headlines: one sentence per project, built only from facts
 * the host observed (the inbox, the merge events, the budgets and the spend
 * ledger). No model writes it and nothing in it is interpreted, so every
 * number is a count or a ratio a person can follow to its list.
 *
 * Example: "Landed 7, needs you 1; main green; spend 62%".
 */

/** Where a headline number leads. The client maps each to a route. */
export type HeadlineLink = "landed" | "needs_you" | "main" | "budgets";

export interface HeadlinePart {
	/** Stable key, so a test and the UI can find a part. */
	key: "landed" | "needs_you" | "main" | "spend" | "held_back" | "review_debt";
	text: string;
	link: HeadlineLink;
	/** Who vouches for this part. */
	claimClass: ClaimClass;
}

export interface Headline {
	project: string;
	/** The sentence the parts were joined into. */
	text: string;
	parts: HeadlinePart[];
	landedToday: number;
	/** Items of class `act`: the number "needs you" links to. */
	needsYou: number;
	/** `null` when no spend budget is configured: shown as nothing, never 0%. */
	spendFraction: number | null;
	/** Of `needsYou`, how many the machine's `act` budget holds back. */
	heldBack?: number;
	reviewDebt?: ReviewDebt;
}

export interface HeadlineAttention {
	heldBack: number;
	debt: ReviewDebt;
}

export interface HeadlineInputs {
	project: string;
	landedToday: number;
	inboxItems: readonly Pick<InboxItem, "kind" | "attention">[];
	/** The budgets in force, as `BudgetService.list()` returns them. */
	budgets: readonly {
		unit: "usd" | "tokens" | "slot_hours";
		fraction: number;
	}[];
	/** This project's share of the act budget; absent reads as nothing held. */
	attention?: HeadlineAttention;
}

/** "3h", "2d": the age of the oldest debt item. */
function shortAge(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The spend figure is the fullest dollar budget: the one closest to holding
 * work. A project with no dollar budget has no spend percentage to show.
 */
export function spendFractionOf(
	budgets: HeadlineInputs["budgets"],
): number | null {
	const usd = budgets.filter((b) => b.unit === "usd");
	if (usd.length === 0) return null;
	return Math.max(...usd.map((b) => b.fraction));
}

/** Pure: shape the collected facts into the sentence and its parts. */
export function buildHeadline(input: HeadlineInputs): Headline {
	const needsYou = input.inboxItems.filter((i) => i.attention === "act").length;
	const mainRed = input.inboxItems.some((i) => i.kind === "main_red");
	const spendFraction = spendFractionOf(input.budgets);

	const parts: HeadlinePart[] = [
		{
			key: "landed",
			text: `Landed ${input.landedToday}`,
			link: "landed",
			claimClass: "host-observed",
		},
		{
			key: "needs_you",
			text: `needs you ${needsYou}`,
			link: "needs_you",
			claimClass: "inference",
		},
		{
			key: "main",
			text: mainRed ? "main red" : "main green",
			link: "main",
			// "green" is only the absence of a red record, not a passing sweep.
			claimClass: mainRed ? "host-observed" : "inference",
		},
	];
	if (spendFraction !== null) {
		parts.push({
			key: "spend",
			text: `spend ${Math.round(spendFraction * 100)}%`,
			link: "budgets",
			// The ledger adds up the usage agents reported.
			claimClass: "agent-reported",
		});
	}
	const heldBack = input.attention?.heldBack ?? 0;
	const reviewDebt = input.attention?.debt ?? { count: 0, oldestAgeMs: null };
	if (heldBack > 0) {
		parts.push({
			key: "held_back",
			text: `${heldBack} held back`,
			link: "needs_you",
			claimClass: "inference",
		});
	}
	if (reviewDebt.count > 0) {
		const age =
			reviewDebt.oldestAgeMs === null
				? ""
				: `, oldest ${shortAge(reviewDebt.oldestAgeMs)}`;
		parts.push({
			key: "review_debt",
			text: `review debt ${reviewDebt.count}${age}`,
			link: "needs_you",
			claimClass: "inference",
		});
	}
	// "Landed 7, needs you 1; main green; spend 62%"
	const text = [
		`${parts[0]?.text}, ${parts[1]?.text}`,
		...parts.slice(2).map((p) => p.text),
	].join("; ");
	return {
		project: input.project,
		text,
		parts,
		landedToday: input.landedToday,
		needsYou,
		spendFraction,
		heldBack,
		reviewDebt,
	};
}

/** The slice of `ProjectServices` the collector reads (so a test can fake it). */
export interface HeadlineSource {
	name: string;
	inbox: { list(): Promise<readonly Pick<InboxItem, "kind" | "attention">[]> };
	budgets: { list(): Promise<HeadlineInputs["budgets"]> };
	/** `merge.completed` events at or after `since`. */
	landedSince(since: Date): Promise<number>;
}

/** Read every fact for one project concurrently. A failed read degrades, never throws. */
export async function collectHeadline(
	src: HeadlineSource,
	now = Date.now(),
	attention?: HeadlineAttention,
): Promise<Headline> {
	const [inbox, budgets, landed] = await Promise.all([
		src.inbox.list().catch(() => []),
		src.budgets.list().catch(() => []),
		src.landedSince(startOfLocalDay(now)).catch(() => 0),
	]);
	return buildHeadline({
		project: src.name,
		landedToday: landed,
		inboxItems: inbox,
		budgets,
		...(attention ? { attention } : {}),
	});
}

/** Merges that landed at or after `since`, from the audit events. */
export async function countLanded(
	handle: ProjectDbHandle,
	since: Date,
): Promise<number> {
	const [row] = await handle.db
		.select({ n: sql<number>`count(*)` })
		.from(events)
		.where(and(eq(events.type, "merge.completed"), gte(events.ts, since)));
	return row?.n ?? 0;
}
