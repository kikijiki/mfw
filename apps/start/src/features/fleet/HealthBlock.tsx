import type { FleetHealthState } from "@mfw/daemon/fleet";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Glyph } from "../../components/icons";
import { formatRelative } from "../../lib/format";
import { HEALTH_LABEL, HEALTH_TOKEN } from "./fleetModel";

/**
 * A node's health, explained. The line says what is wrong in words ("AMD GPU
 * probe: tool not installed"); the disclosure under it shows each check with
 * the probe's own sentence, since when, what mfw does about it and what to do.
 * A healthy node says "All checks ok". Several checks (cpu, memory, gpu...)
 * live in one block whose overall state is the worst of them.
 */

export interface HealthItemView {
	kind: string;
	label: string;
	status: FleetHealthState;
	code: string | null;
	summary: string;
	message: string | null;
	since: number | null;
	lastOkAt: number | null;
	checkedAt: number | null;
	consecutiveFailures: number;
	affects: string | null;
	hint: string | null;
	transient: boolean;
}

export interface HealthView {
	state: FleetHealthState;
	detail: string | null;
	checkedAt: number | null;
	items: HealthItemView[];
}

/** The one-line headline for a node's health. */
export function healthHeadline(health: HealthView): string {
	if (health.state === "ok")
		return health.items.length > 1 ? "All checks ok" : "ok";
	if (health.detail) return health.detail;
	return HEALTH_LABEL[health.state];
}

function Dot({ status }: { status: FleetHealthState }) {
	return (
		<span style={{ color: `var(${HEALTH_TOKEN[status]})` }}>
			<Glyph name="dot" className="mr-1 inline size-2.5 align-[-1px]" />
		</span>
	);
}

function ItemDetail({ item, now }: { item: HealthItemView; now: number }) {
	const rows: Array<[string, string]> = [];
	if (item.message) rows.push(["What the probe said", item.message]);
	if (item.since !== null)
		rows.push([
			"In this state since",
			`${formatRelative(item.since, now)}${
				item.consecutiveFailures > 1
					? ` (${item.consecutiveFailures} checks in a row)`
					: ""
			}`,
		]);
	rows.push([
		"Last ok",
		item.lastOkAt !== null
			? formatRelative(item.lastOkAt, now)
			: "not seen ok since mfw started",
	]);
	if (item.checkedAt !== null)
		rows.push(["Last checked", formatRelative(item.checkedAt, now)]);
	if (item.affects) rows.push(["What it affects", item.affects]);
	if (item.hint) rows.push(["What to do", item.hint]);
	return (
		<dl
			className="m-0 grid gap-x-3 gap-y-0.5 pl-4"
			style={{
				gridTemplateColumns: "max-content minmax(0, 1fr)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			{rows.map(([k, v]) => (
				<div key={k} className="contents">
					<dt style={{ color: "var(--mfw-fg-faint)" }}>{k}</dt>
					<dd className="m-0" style={{ color: "var(--mfw-fg-muted)" }}>
						{v}
					</dd>
				</div>
			))}
		</dl>
	);
}

export function HealthBlock({
	health,
	now,
	onRecheck,
	rechecking = false,
	defaultOpen = false,
}: {
	health: HealthView;
	now: number;
	/** Present only where a safe single-flight re-probe exists (this machine). */
	onRecheck?: () => void;
	rechecking?: boolean;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const headline = healthHeadline(health);
	const expandable = health.items.length > 0;
	const headlineEl = (
		<span
			style={{
				color: `var(${HEALTH_TOKEN[health.state]})`,
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			<Glyph name="dot" className="mr-1 inline size-2.5 align-[-1px]" />
			{headline}
		</span>
	);
	return (
		<div data-health={health.state} className="flex flex-col gap-1">
			{expandable ? (
				<button
					type="button"
					aria-expanded={open}
					aria-label={`Health: ${headline}. ${open ? "Hide" : "Show"} details`}
					onClick={() => setOpen((v) => !v)}
					className="mfw-focus inline-flex items-center gap-1 self-start text-left"
				>
					{headlineEl}
					{open ? (
						<ChevronDown aria-hidden className="size-3" />
					) : (
						<ChevronRight aria-hidden className="size-3" />
					)}
				</button>
			) : (
				headlineEl
			)}
			{open && expandable ? (
				<div
					data-health-detail
					className="flex flex-col gap-2 border-l pl-2"
					style={{ borderColor: "var(--mfw-border)" }}
				>
					{health.items.map((item) => (
						<div
							key={item.kind}
							data-health-item={item.kind}
							data-status={item.status}
							className="flex flex-col gap-0.5"
						>
							<span style={{ fontSize: "var(--mfw-text-xs)" }}>
								<Dot status={item.status} />
								{item.transient ? `${item.summary} (retrying)` : item.summary}
							</span>
							{item.status !== "ok" ? (
								<ItemDetail item={item} now={now} />
							) : null}
						</div>
					))}
					{onRecheck ? (
						<button
							type="button"
							disabled={rechecking}
							onClick={onRecheck}
							className="mfw-focus self-start underline"
							style={{
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{rechecking ? "Re-checking..." : "Re-check now"}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
