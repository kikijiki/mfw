import type { InboxItem, InboxKind, InboxSeverity } from "@mfw/daemon/inbox";
import {
	BrainCircuit,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	CircleX,
	Eye,
	FileStack,
	Hourglass,
	ListPlus,
	type LucideIcon,
	MessageCircleQuestion,
	OctagonAlert,
	PauseCircle,
	PenLine,
	ShieldAlert,
	Wallet,
	Wrench,
	X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { Chip } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import type { RouterOutputs } from "../../lib/trpc";
import { href } from "../../routes";
import { RunConsole } from "../agents/RunConsole";
import { AnswerBox } from "../clarify/AnswerBox";
import { LetBrainDecide } from "../inspector/MessageBrain";
import { runBranchName } from "../repo/repoModel";
import { answersInPlace, needTarget, oldestFirst } from "./needs";
import { useNeedActions } from "./useNeedActions";

type ActiveRun = RouterOutputs["runs"]["active"][number];

const KIND_ICON: Record<InboxKind, LucideIcon> = {
	main_red: OctagonAlert,
	merge_parked: OctagonAlert,
	clarify: MessageCircleQuestion,
	review: Eye,
	blocked: PauseCircle,
	trigger_disarmed: ShieldAlert,
	trigger_failed: CircleX,
	failed_run: CircleX,
	sweep_infra: Wrench,
	verify_infra: Wrench,
	draft_failed: PenLine,
	admission: ShieldAlert,
	ownership_conflict: FileStack,
	followups: ListPlus,
	needs_answer: MessageCircleQuestion,
	approval_pending: ShieldAlert,
	stalled: Hourglass,
	budget: Wallet,
	brain_stuck: BrainCircuit,
	brain_notice: BrainCircuit,
};

const SEVERITY_RANK: Record<InboxSeverity, number> = {
	critical: 0,
	attention: 1,
	info: 2,
};

const SEVERITY_TOKEN: Record<InboxSeverity, string> = {
	critical: "--mfw-critical",
	attention: "--mfw-warn",
	info: "--mfw-neutral",
};

/** Most severe first, then oldest first: the order a person should work them. */
export function queueOrder(items: readonly InboxItem[]): InboxItem[] {
	return oldestFirst(items).sort(
		(a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
	);
}

/** Which inline control a kind gets. Kinds not listed are opened, not acted on, here. */
export type InlineKind =
	| "answer"
	| "run"
	| "merge"
	| "review"
	| "brain"
	| "open";

export function inlineKind(kind: InboxKind): InlineKind {
	if (answersInPlace(kind)) return "answer";
	if (kind === "approval_pending" || kind === "stalled") return "run";
	if (kind === "merge_parked") return "merge";
	if (kind === "review") return "review";
	if (kind === "brain_notice") return "brain";
	return "open";
}

/**
 * The needs-you queue: `inbox.list`, every row answerable where it is shown.
 * A question takes its answer box, an approval or stall expands the run's
 * console (approve, steer, stop), a parked merge retries or is abandoned,
 * a review opens the task inspector's Changes tab.
 *
 * It renders exactly the items it is given; the caller passes the whole of
 * `inbox.list`, so the count here is the shell badge.
 */
export function NeedsQueue({
	items,
	runs,
	onNavigate,
	empty = true,
}: {
	items: readonly InboxItem[];
	/** `runs.active`, to find the live run an approval or stall belongs to. */
	runs: readonly ActiveRun[] | undefined;
	/** Called after a row's own link is followed (closes a popover). */
	onNavigate?: () => void;
	/** Render the all-clear state when there are no items. */
	empty?: boolean;
}) {
	const actions = useNeedActions();
	const ordered = queueOrder(items);

	if (ordered.length === 0) {
		return empty ? (
			<Empty
				icon={CircleCheck}
				tone="success"
				className="py-4"
				title="Nothing needs you."
				description="Questions, approvals, reviews and parked merges show up here."
			/>
		) : null;
	}

	return (
		<>
			<ul className="flex flex-col gap-2">
				{ordered.map((item) => (
					<NeedRow
						key={item.id}
						item={item}
						run={
							item.runId
								? runs?.find(
										(r) => r.project === item.project && r.runId === item.runId,
									)
								: undefined
						}
						actions={actions}
						onNavigate={onNavigate}
					/>
				))}
			</ul>
			{actions.dialog}
		</>
	);
}

function NeedRow({
	item,
	run,
	actions,
	onNavigate,
}: {
	item: InboxItem;
	run: ActiveRun | undefined;
	actions: ReturnType<typeof useNeedActions>;
	onNavigate?: () => void;
}) {
	const Icon = KIND_ICON[item.kind];
	const token = SEVERITY_TOKEN[item.severity];
	const inline = inlineKind(item.kind);
	const target = needTarget(item);
	// Answered here, so a link back to Home would be a no-op.
	const linkTitle = inline === "answer" ? null : target;
	const [consoleOpen, setConsoleOpen] = useState(false);

	return (
		<li
			data-need={item.kind}
			className="flex flex-col gap-1.5 border p-2"
			style={{
				borderColor: `color-mix(in oklch, var(${token}) 40%, var(--mfw-border))`,
				borderRadius: "var(--mfw-radius-md)",
				background: "var(--mfw-bg-raised)",
			}}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Icon
					aria-hidden
					className="size-4 shrink-0"
					style={{ color: `var(${token})` }}
				/>
				<Chip>{item.project}</Chip>
				{item.taskId ? (
					<AppLink
						to={href.task(item.project, item.taskId)}
						className="mfw-num"
						onClick={onNavigate}
					>
						{item.taskId}
					</AppLink>
				) : null}
				{linkTitle ? (
					<AppLink
						to={linkTitle}
						className="min-w-0 flex-1 truncate font-medium"
						onClick={onNavigate}
					>
						{item.title}
					</AppLink>
				) : (
					<span className="min-w-0 flex-1 truncate font-medium">
						{item.title}
					</span>
				)}
				<span
					className="shrink-0"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					<RelativeTime value={item.ts} />
				</span>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label={`Dismiss: ${item.title}`}
					onClick={() => actions.dismiss(item)}
				>
					<X aria-hidden />
				</Button>
			</div>

			{item.detail ? (
				<p
					className="m-0"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{item.detail}
				</p>
			) : null}
			{item.fix ? (
				<p className="m-0" style={{ fontSize: "var(--mfw-text-xs)" }}>
					Fix: {item.fix}
				</p>
			) : null}

			{inline === "answer" && item.runId ? (
				<AnswerBox project={item.project} runId={item.runId} />
			) : null}

			{inline === "run" ? (
				run ? (
					<div className="flex flex-col gap-2">
						<Button
							size="sm"
							variant="outline"
							className="self-start"
							aria-expanded={consoleOpen}
							onClick={() => setConsoleOpen((v) => !v)}
						>
							{consoleOpen ? (
								<ChevronDown aria-hidden />
							) : (
								<ChevronRight aria-hidden />
							)}
							{item.kind === "approval_pending"
								? consoleOpen
									? "Hide approval"
									: "Review approval"
								: consoleOpen
									? "Hide the run"
									: "Steer or stop"}
						</Button>
						{/* Mounted only while open: one console is one transcript stream. */}
						{consoleOpen ? (
							<RunConsole
								target={{
									project: run.project,
									runId: run.runId,
									label: run.label,
									state: run.state,
									capabilities: run.capabilities,
								}}
								lines={24}
								heightClass="h-56"
							/>
						) : null}
					</div>
				) : item.runId ? (
					<span style={{ fontSize: "var(--mfw-text-xs)" }}>
						The run is no longer live.{" "}
						<AppLink
							to={href.run(item.project, item.runId)}
							onClick={onNavigate}
						>
							Open the transcript
						</AppLink>
					</span>
				) : null
			) : null}

			{inline === "merge" && item.mergeJobId !== undefined ? (
				<div className="flex flex-wrap items-center gap-2">
					{item.runId ? (
						<Button size="sm" variant="ghost" asChild>
							<AppLink
								to={href.repoBranch(item.project, runBranchName(item.runId))}
								onClick={onNavigate}
							>
								View branch
							</AppLink>
						</Button>
					) : null}
					<Button
						size="sm"
						variant="outline"
						onClick={() => actions.retryMerge(item)}
					>
						Retry
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => actions.requestMerge(item, "sendToReady")}
					>
						Send to ready
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => actions.requestMerge(item, "abandon")}
					>
						Abandon
					</Button>
				</div>
			) : null}

			{inline === "brain" ? (
				<div className="flex flex-wrap items-center gap-2">
					<LetBrainDecide
						project={item.project}
						title={item.title.replace(/^brain: /, "")}
						{...(item.taskId ? { taskId: item.taskId } : {})}
						onDone={() => actions.dismiss(item)}
					/>
					<Button size="sm" variant="ghost" asChild>
						<AppLink to={target} onClick={onNavigate}>
							Open in the brain
						</AppLink>
					</Button>
				</div>
			) : null}

			{inline === "review" ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" asChild>
						<AppLink to={target} onClick={onNavigate}>
							Open changes
						</AppLink>
					</Button>
				</div>
			) : null}
		</li>
	);
}
