import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Glyph } from "../../components/icons";
import { Chip } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { humanizeToken } from "../../lib/format";
import { href } from "../../routes";
import {
	actionStateOf,
	type BrainDecision,
	decisionTarget,
	escalationOf,
	isProposed,
	outcomeChip,
} from "../brain/brain";
import {
	canOverride,
	decisionRuns,
	humanRowOf,
	outcomeSummary,
} from "../brain/steering";
import { OverrideDialog } from "./OverrideDialog";

/**
 * One brain decision (design §7.4): tool, target, confidence, the first line
 * of the rationale and an outcome chip; expanding shows the whole rationale,
 * the alternatives it weighed, what it had read and what it caused.
 *
 * While the brain runs in shadow mode every call is `proposed`; the chip says
 * so and that the fixed pipeline, not the brain, acted.
 */

const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;

export const SHADOW_TITLE =
	"Shadow mode: the brain proposed this and the fixed pipeline decided and acted. Compare the two here.";

/** The first non-empty line, capped. */
export function firstLine(text: string | null | undefined, max = 140): string {
	const line = (text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

export function DecisionRow({
	decision: d,
	project,
	defaultOpen = false,
}: {
	decision: BrainDecision;
	project: string;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const [overriding, setOverriding] = useState(false);
	const human = humanRowOf(d);
	if (human) {
		// A person's own row (an override, a message): what you did to the brain.
		return (
			<li
				data-testid="decision-row"
				data-human="true"
				className="flex min-w-0 flex-col gap-1 border-b px-3 py-1.5"
				style={{ borderColor: "var(--mfw-border)", ...small }}
			>
				<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<Glyph name="hand" label="your action" token="--mfw-accent" />
					<span className="mfw-num" style={muted}>
						{d.id}
					</span>
					<strong>{human.label}</strong>
					<Chip tone="info">you</Chip>
					{human.detail ? <span style={muted}>{human.detail}</span> : null}
					<RelativeTime value={d.ts} className="ml-auto" />
				</span>
				{d.reason ? (
					<p className="m-0 min-w-0 break-words" style={muted}>
						{d.reason}
					</p>
				) : null}
			</li>
		);
	}
	const target = decisionTarget(d);
	const outcome = outcomeChip(d);
	const escalation = escalationOf(d);
	const rejection = (
		d.output as {
			rejection?: { code?: string; message?: string; fix?: { text?: string } };
		}
	).rejection;
	const result = (d.output as { result?: unknown }).result;
	const refs = d.contextRefs;
	const tool = d.action ?? d.kind ?? "decision";
	const alternatives = d.alternatives ?? [];
	const summary = outcomeSummary(d.outcome);
	const runs = decisionRuns(d);
	const overridable = canOverride(d);

	return (
		<li
			data-testid="decision-row"
			data-escalation={escalation ? "true" : undefined}
			className="flex min-w-0 flex-col gap-1 border-b px-3 py-1.5"
			style={{
				borderColor: "var(--mfw-border)",
				...(escalation
					? { borderLeft: "3px solid var(--mfw-warn)" }
					: undefined),
			}}
		>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="mfw-focus flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-0 bg-transparent p-0 text-left"
				style={small}
			>
				{open ? (
					<ChevronDown aria-hidden className="size-3 shrink-0" />
				) : (
					<ChevronRight aria-hidden className="size-3 shrink-0" />
				)}
				<Glyph name="diamond" label="brain decision" token="--mfw-accent" />
				<span className="mfw-num" style={muted}>
					{d.id}
				</span>
				<strong>{humanizeToken(tool)}</strong>
				{target ? <span style={muted}>{target}</span> : null}
				{d.confidence ? (
					<Chip tone={d.confidence === "low" ? "warn" : "neutral"}>
						{d.confidence}
					</Chip>
				) : null}
				{isProposed(d) ? (
					<Chip tone="info" title={SHADOW_TITLE}>
						shadow: proposed
					</Chip>
				) : null}
				{isProposed(d) ? null : (
					<Chip tone={outcome.tone}>{outcome.label}</Chip>
				)}
				{escalation ? <Chip tone="warn">needs you</Chip> : null}
			</button>
			{d.reason ? (
				<p className="m-0 min-w-0 break-words" style={{ ...muted, ...small }}>
					{open ? d.reason : firstLine(d.reason)}
				</p>
			) : null}
			{open ? (
				<div
					className="flex flex-col gap-1.5 pl-5"
					style={small}
					data-testid="decision-detail"
				>
					{isProposed(d) ? (
						<p className="m-0" style={muted}>
							{SHADOW_TITLE}
						</p>
					) : null}
					{rejection ? (
						<p className="m-0" style={{ color: "var(--mfw-critical)" }}>
							Rejected{rejection.code ? ` (${rejection.code})` : ""}:{" "}
							{rejection.message}
							{rejection.fix?.text ? ` Fix: ${rejection.fix.text}` : ""}
						</p>
					) : null}
					{escalation ? (
						<div className="flex flex-col gap-0.5">
							<strong>{escalation.title}</strong>
							{escalation.body ? (
								<span className="break-words" style={muted}>
									{escalation.body}
								</span>
							) : null}
							{escalation.options.length > 0 ? (
								<span style={muted}>
									Options: {escalation.options.join(" · ")}
								</span>
							) : null}
							{escalation.blocking.length > 0 ? (
								<span style={muted}>
									Blocking:{" "}
									{escalation.blocking.map((id, i) => (
										<span key={id}>
											{i > 0 ? ", " : ""}
											<AppLink to={href.task(project, id)}>{id}</AppLink>
										</span>
									))}
								</span>
							) : null}
						</div>
					) : null}
					{alternatives.length > 0 ? (
						<div>
							<span style={muted}>Alternatives considered</span>
							<ul className="m-0 list-disc pl-4">
								{alternatives.map((a) => (
									<li key={a.option}>
										<strong>{a.option}</strong>
										<span style={muted}>
											{" "}
											{"—"} {a.why_not}
										</span>
									</li>
								))}
							</ul>
						</div>
					) : null}
					{refs &&
					(refs.events?.length || refs.runs?.length || refs.tasks?.length) ? (
						<p className="m-0" style={muted}>
							Read: {refs.tasks?.length ?? 0} tasks, {refs.runs?.length ?? 0}{" "}
							runs, {refs.events?.length ?? 0} events
						</p>
					) : null}
					{result && typeof result === "object" ? (
						<p className="m-0 break-words" style={muted}>
							{actionStateOf(d.output) === "proposed" ? "Would do" : "Did"}:{" "}
							{JSON.stringify(result)}
						</p>
					) : null}
					<p className="m-0 flex flex-wrap items-center gap-x-2" style={muted}>
						<RelativeTime value={d.ts} />
						{d.turnRunId ? (
							<AppLink
								to={href.board(project, { node: `turn:${d.turnRunId}` })}
							>
								turn {d.turnRunId.slice(-6)}
							</AppLink>
						) : null}
						{target ? (
							<AppLink to={href.board(project, { node: target })}>
								open {target}
							</AppLink>
						) : null}
						{runs.map((runId) => (
							<AppLink
								key={runId}
								to={href.board(project, { node: `run:${runId}` })}
							>
								run {runId.slice(-6)}
							</AppLink>
						))}
						{d.overriddenBy != null ? (
							<AppLink
								to={href.board(project, { node: `decision:${d.overriddenBy}` })}
							>
								overridden by decision {d.overriddenBy}
							</AppLink>
						) : null}
					</p>
					{summary ? (
						<p className="m-0" style={muted} data-testid="decision-outcome">
							Outcome: {summary}
						</p>
					) : null}
					{overridable ? (
						<div>
							<Button
								size="xs"
								variant="outline"
								onClick={() => setOverriding(true)}
							>
								<Undo2 aria-hidden /> Override
							</Button>
						</div>
					) : null}
				</div>
			) : null}
			{overridable ? (
				<OverrideDialog
					project={project}
					decisionId={d.id}
					open={overriding}
					onOpenChange={setOverriding}
				/>
			) : null}
		</li>
	);
}
