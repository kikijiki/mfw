import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Bug,
	ChevronDown,
	ChevronRight,
	FlaskConical,
	Ghost,
	KeyRound,
	type LucideIcon,
	Plus,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
	ShieldOff,
	ShieldQuestion,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { HelpTip } from "../../components/HelpTip";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader, Scroller } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { humanizeToken, summarizePayload } from "../../lib/format";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { diffLines } from "../review/diff";
import {
	QuickDraftCaptureDialog,
	type QuickDraftCaptureDialogProps,
} from "../tasks/QuickDraftCaptureDialog";

/**
 * Triggers: the human surface over `TriggerService`.
 *
 * "Present, not armed" is shown loudly; `state` is explicit on every row and
 * the project tab badge counts triggers not armed-and-working (`ProjectLayout.tsx`).
 *
 * The definition lives in the repo (`.mfw/triggers/<id>.md`), the arming record
 * in the daemon's home (§4). This screen only writes the arming record;
 * definitions change through the normal worktree/branch/merge path.
 */

type TriggerView = RouterOutputs["triggers"]["list"][number];
type DeliveryView = RouterOutputs["triggers"]["deliveries"][number];
type CapturedTask = Parameters<QuickDraftCaptureDialogProps["onSuccess"]>[0];

export const TRIGGER_TASK_PROMPT_PREFIX = "Create a trigger: ";

export function triggerTaskCreatedToast(
	task: Pick<CapturedTask, "id" | "title">,
) {
	return {
		tone: "success" as const,
		title: `${task.id} created`,
		description: task.title,
	};
}

/** Kept hook-free so the Triggers entry-point contract is easy to regress. */
export function TriggerTaskCreateAction({
	project,
	open,
	onOpenChange,
	onSuccess,
}: Pick<
	QuickDraftCaptureDialogProps,
	"project" | "open" | "onOpenChange" | "onSuccess"
>) {
	return (
		<>
			<Button onClick={() => onOpenChange(true)}>
				<Plus aria-hidden /> Create task
			</Button>
			<QuickDraftCaptureDialog
				project={project}
				open={open}
				onOpenChange={onOpenChange}
				initialPromptPrefix={TRIGGER_TASK_PROMPT_PREFIX}
				onSuccess={onSuccess}
			/>
		</>
	);
}

const STATE_LOOK: Record<
	TriggerView["state"],
	{ icon: LucideIcon; token: string; label: string }
> = {
	armed: { icon: ShieldCheck, token: "--mfw-ok", label: "armed" },
	unarmed: { icon: ShieldQuestion, token: "--mfw-warn", label: "not armed" },
	drifted: { icon: ShieldAlert, token: "--mfw-critical", label: "drifted" },
	disabled: { icon: ShieldOff, token: "--mfw-fg-faint", label: "disabled" },
	"needs-secrets": {
		icon: KeyRound,
		token: "--mfw-warn",
		label: "needs secrets",
	},
	orphaned: { icon: Ghost, token: "--mfw-critical", label: "orphaned" },
	quarantined: { icon: Bug, token: "--mfw-critical", label: "quarantined" },
};

export function TriggersPage({
	project,
	highlight,
}: {
	project: string;
	highlight?: string;
}) {
	const trpc = useTRPC();
	const { toast } = useToast();
	const triggers = useQuery(trpc.triggers.list.queryOptions({ project }));
	const rows = triggers.data ?? [];
	const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
	const [showQuickCapture, setShowQuickCapture] = useState(false);

	useEffect(() => {
		if (!highlight) return;
		rowRefs.current[highlight]?.scrollIntoView({
			block: "center",
			behavior: "smooth",
		});
	}, [highlight]);

	return (
		<Page className="h-full">
			{/* No title: the Triggers tab above already says where you are. */}
			<PageHeader
				actions={
					<TriggerTaskCreateAction
						project={project}
						open={showQuickCapture}
						onOpenChange={setShowQuickCapture}
						onSuccess={(task) => toast(triggerTaskCreatedToast(task))}
					/>
				}
				meta={
					<span>
						{rows.length} trigger{rows.length === 1 ? "" : "s"}
					</span>
				}
			/>
			<Scroller className="p-3">
				{triggers.isLoading ? (
					<LoadingRows rows={4} />
				) : triggers.error ? (
					<ErrorState
						title="Could not load triggers"
						error={triggers.error}
						onRetry={() => void triggers.refetch()}
					/>
				) : rows.length === 0 ? (
					<Empty
						icon={ShieldQuestion}
						title="No triggers yet."
						description="Create a trigger to automate an action when a project event occurs."
					/>
				) : (
					<ul className="flex flex-col gap-2">
						{rows.map((view) => (
							<TriggerRow
								key={view.id}
								ref={(node) => {
									rowRefs.current[view.id] = node;
								}}
								project={project}
								view={view}
								highlighted={view.id === highlight}
							/>
						))}
					</ul>
				)}
			</Scroller>
		</Page>
	);
}

function TriggerRow({
	project,
	view,
	highlighted,
	ref,
}: {
	project: string;
	view: TriggerView;
	highlighted: boolean;
	ref: (node: HTMLLIElement | null) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [grant, setGrant] = useState<Set<string>>(
		new Set(view.requestedSecrets),
	);
	const [armReview, setArmReview] = useState<TriggerView | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [showDryRun, setShowDryRun] = useState(false);

	const invalidate = () =>
		void queryClient.invalidateQueries(
			trpc.triggers.list.queryFilter({ project }),
		);

	const armMutation = useMutation(
		trpc.triggers.arm.mutationOptions({
			meta: { label: "Approve trigger" },
			onSuccess: () => {
				setArmReview(null);
				toast({ tone: "success", title: `${view.id} armed` });
			},
			onSettled: invalidate,
		}),
	);
	const disarmMutation = useMutation(
		trpc.triggers.disarm.mutationOptions({
			meta: { label: "Disarm trigger" },
			onSuccess: () => toast({ tone: "info", title: `${view.id} disarmed` }),
			onSettled: invalidate,
		}),
	);

	const look = STATE_LOOK[view.state];
	const Icon = look.icon;
	const hasArmingRecord = view.armedAt !== undefined;

	return (
		<li
			ref={ref}
			className="flex flex-col gap-2 border p-2.5"
			style={{
				borderColor: highlighted ? `var(${look.token})` : "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-md)",
				background: highlighted
					? "var(--mfw-bg-hover)"
					: "var(--mfw-bg-raised)",
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Icon
					aria-hidden
					className="size-4 shrink-0"
					style={{ color: `var(${look.token})` }}
				/>
				<span className="font-medium">{view.title}</span>
				<Mono value={view.id} className="text-[color:var(--mfw-fg-faint)]" />
				<Chip
					tone={
						view.state === "armed"
							? "ok"
							: view.state === "disabled"
								? "neutral"
								: view.state === "unarmed" || view.state === "needs-secrets"
									? "warn"
									: "critical"
					}
				>
					{look.label}
				</Chip>
				{view.on ? <Chip>{view.on}</Chip> : null}
				{view.action ? <Chip>{view.action}</Chip> : null}
				<span className="flex-1" />
				<Button size="xs" variant="ghost" onClick={() => setShowDryRun(true)}>
					<FlaskConical aria-hidden /> Test matcher
				</Button>
				<HelpTip label="About testing a trigger">
					Shows which recent events match without running the action. Use
					History → Retry to run a previous event again.
				</HelpTip>
				{view.state === "unarmed" ||
				view.state === "drifted" ||
				view.state === "needs-secrets" ? (
					<Button
						size="xs"
						variant="outline"
						aria-expanded={armReview !== null}
						onClick={() => setArmReview(view)}
					>
						<ShieldCheck aria-hidden /> Review changes
					</Button>
				) : null}
				{hasArmingRecord ? (
					<Button
						size="xs"
						variant="destructive"
						disabled={disarmMutation.isPending}
						onClick={() => disarmMutation.mutate({ project, defId: view.id })}
					>
						{disarmMutation.isPending ? "Disarming…" : "Disarm"}
					</Button>
				) : null}
			</div>

			{view.reason ? (
				<p
					className="flex items-start gap-1.5"
					style={{
						color: `var(${look.token})`,
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{view.reason}
				</p>
			) : null}

			<div
				className="flex flex-wrap items-center gap-2"
				style={{ fontSize: "var(--mfw-text-xs)", color: "var(--mfw-fg-muted)" }}
			>
				{view.file ? <Mono value={view.file} /> : null}
				{view.lastDelivery ? (
					<>
						<span>last run:</span>
						<Chip tone={deliveryTone(view.lastDelivery.state)}>
							{view.lastDelivery.state}
						</Chip>
						<RelativeTime value={view.lastDelivery.startedAt} />
						{view.lastDelivery.detail ? (
							<span
								className="min-w-0 max-w-100 truncate"
								title={view.lastDelivery.detail}
							>
								{view.lastDelivery.detail}
							</span>
						) : null}
					</>
				) : (
					<span>never run</span>
				)}
				<span className="flex-1" />
				<button
					type="button"
					className="mfw-focus flex items-center gap-1 underline-offset-2 hover:underline"
					aria-expanded={showHistory}
					onClick={() => setShowHistory((v) => !v)}
				>
					{showHistory ? (
						<ChevronDown aria-hidden />
					) : (
						<ChevronRight aria-hidden />
					)}
					history
				</button>
			</div>

			{showHistory ? (
				<DeliveryHistory project={project} defId={view.id} />
			) : null}

			{showDryRun ? (
				<DryRunPanel
					project={project}
					defId={view.id}
					onClose={() => setShowDryRun(false)}
				/>
			) : null}

			<TriggerArmReview
				view={armReview ?? view}
				open={armReview !== null}
				onOpenChange={(open) => {
					if (!open) setArmReview(null);
				}}
				grant={grant}
				onGrantChange={setGrant}
				pending={armMutation.isPending}
				onApprove={() => {
					if (!armReview?.hash) return;
					armMutation.mutate({
						project,
						defId: armReview.id,
						expectedHash: armReview.hash,
						secrets: Array.from(grant),
					});
				}}
			/>
		</li>
	);
}

export function TriggerArmReview({
	view,
	open,
	onOpenChange,
	grant,
	onGrantChange,
	pending,
	onApprove,
}: {
	view: TriggerView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	grant: Set<string>;
	onGrantChange: (next: Set<string>) => void;
	pending: boolean;
	onApprove: () => void;
}) {
	const current = view.definition ?? "";
	const approved = view.approvedDefinition;
	const rows = approved === undefined ? [] : diffLines(approved, current);
	const hasChanges = rows.some((row) => row.kind !== "context");

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent className="mfw-v2 max-h-[90vh] overflow-hidden sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle>Review {view.id}</DialogTitle>
					<DialogDescription>
						Approving pins this exact definition. Any later change disarms it.
					</DialogDescription>
				</DialogHeader>

				<div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
					<div className="flex flex-wrap gap-2">
						{view.on ? <Chip>{view.on}</Chip> : null}
						{view.action ? <Chip>{view.action}</Chip> : null}
						{view.hash ? <Mono value={view.hash} truncate={18} /> : null}
					</div>

					{approved === undefined ? (
						<div className="flex flex-col gap-1">
							<span style={{ color: "var(--mfw-fg-muted)" }}>
								First approval: review the complete definition.
							</span>
							<pre className="overflow-auto border p-3 text-xs">{current}</pre>
						</div>
					) : !hasChanges ? (
						<p>No definition changes. Review any secret grants below.</p>
					) : (
						<div className="overflow-auto border font-mono text-xs">
							{rows.flatMap((row) => {
								const key = `${row.kind}:${row.oldLine ?? 0}:${row.newLine ?? 0}`;
								if (row.kind === "change") {
									return [
										<DiffLine
											key={`${key}:old`}
											kind="del"
											text={row.oldText ?? ""}
										/>,
										<DiffLine
											key={`${key}:new`}
											kind="add"
											text={row.newText ?? ""}
										/>,
									];
								}
								return [
									<DiffLine
										key={key}
										kind={row.kind}
										text={row.newText ?? row.oldText ?? ""}
									/>,
								];
							})}
						</div>
					)}

					{view.requestedSecrets.length > 0 ? (
						<div className="flex flex-col gap-2 border p-3">
							<span className="flex items-center gap-1">
								Secret access
								<HelpTip label="About trigger secrets">
									A trigger receives only the saved secrets selected here.
								</HelpTip>
							</span>
							{view.requestedSecrets.map((name) => {
								const inputId = `secret-${view.id}-${name}`;
								return (
									<label
										key={name}
										htmlFor={inputId}
										className="flex items-center gap-2"
									>
										<Checkbox
											id={inputId}
											checked={grant.has(name)}
											onCheckedChange={(checked) => {
												const next = new Set(grant);
												if (checked) next.add(name);
												else next.delete(name);
												onGrantChange(next);
											}}
										/>
										<Mono value={name} />
									</label>
								);
							})}
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button
						variant="ghost"
						disabled={pending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={pending || current.length === 0}
						onClick={onApprove}
					>
						{pending ? "Approving…" : "Approve and arm"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function DiffLine({
	kind,
	text,
}: {
	kind: "context" | "add" | "del";
	text: string;
}) {
	const prefix = kind === "add" ? "+" : kind === "del" ? "−" : " ";
	return (
		<div
			className="whitespace-pre px-2 py-0.5"
			style={{
				background:
					kind === "add"
						? "var(--mfw-diff-add-bg)"
						: kind === "del"
							? "var(--mfw-diff-del-bg)"
							: undefined,
			}}
		>
			{prefix} {text}
		</div>
	);
}

function deliveryTone(
	state: string,
): "ok" | "critical" | "warn" | "neutral" | "info" {
	if (state === "ok") return "ok";
	if (state === "failed" || state === "dead") return "critical";
	if (state === "running") return "info";
	return "neutral";
}

function DeliveryHistory({
	project,
	defId,
}: {
	project: string;
	defId: string;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const deliveries = useQuery(
		trpc.triggers.deliveries.queryOptions({ project, defId, limit: 20 }),
	);

	const retryMutation = useMutation(
		trpc.triggers.retry.mutationOptions({
			meta: { label: "Retry trigger" },
			onSuccess: (view) =>
				toast({
					tone: view.state === "ok" ? "success" : "warning",
					title: `Retry ${view.state}`,
				}),
			onSettled: () =>
				void queryClient.invalidateQueries(
					trpc.triggers.deliveries.queryFilter({ project, defId }),
				),
		}),
	);

	const rows: DeliveryView[] = deliveries.data ?? [];

	return (
		<div
			className="flex flex-col gap-1 border-t pt-2"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			{deliveries.isLoading ? (
				<LoadingRows rows={2} />
			) : deliveries.error ? (
				<ErrorState
					title="Could not load trigger history"
					error={deliveries.error}
					onRetry={() => void deliveries.refetch()}
				/>
			) : rows.length === 0 ? (
				<span
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					No previous runs.
				</span>
			) : (
				<ul className="flex flex-col gap-1">
					{rows.map((d) => (
						<li
							key={d.id}
							className="flex flex-wrap items-center gap-2"
							style={{ fontSize: "var(--mfw-text-2xs)" }}
						>
							<Chip tone={deliveryTone(d.state)}>{d.state}</Chip>
							<span style={{ color: "var(--mfw-fg-faint)" }}>
								seq {d.eventSeq}
							</span>
							<span>{humanizeToken(d.eventType)}</span>
							{d.attempt > 1 ? <span>attempt {d.attempt}</span> : null}
							<RelativeTime value={d.startedAt} />
							{d.detail ? (
								<span
									className="min-w-0 max-w-80 truncate"
									style={{ color: "var(--mfw-fg-muted)" }}
									title={d.detail}
								>
									{d.detail}
								</span>
							) : null}
							{d.runId ? <Mono value={d.runId} truncate={8} /> : null}
							<span className="flex-1" />
							<Button
								size="xs"
								variant="ghost"
								disabled={d.state === "running" || retryMutation.isPending}
								onClick={() =>
									retryMutation.mutate({ project, deliveryId: d.id })
								}
							>
								<RefreshCw aria-hidden /> Retry
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Dry run against the last N events: no action execution, no cursor movement (§9.4). Loaded on demand. */
function DryRunPanel({
	project,
	defId,
	onClose,
}: {
	project: string;
	defId: string;
	onClose: () => void;
}) {
	const trpc = useTRPC();
	const result = useQuery(
		trpc.triggers.dryRun.queryOptions({ project, defId }),
	);
	const matches = result.data ?? [];

	return (
		<div
			className="flex flex-col gap-2 border-t pt-2"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="flex items-center gap-2">
				<FlaskConical aria-hidden className="size-3.5" />
				<span
					style={{
						fontSize: "var(--mfw-text-xs)",
						color: "var(--mfw-fg-muted)",
					}}
				>
					Events this trigger matches in the last 200. No action executes. To
					execute one again, open History and use Retry.
				</span>
				<span className="flex-1" />
				<Button size="xs" variant="ghost" onClick={onClose}>
					Close
				</Button>
			</div>
			{result.isLoading ? (
				<LoadingRows rows={2} />
			) : result.error ? (
				<ErrorState
					title="Matcher test failed"
					error={result.error}
					onRetry={() => void result.refetch()}
				/>
			) : matches.length === 0 ? (
				<span
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					No match in the last 200 events.
				</span>
			) : (
				<ul className="flex flex-col gap-1">
					{matches.map((m) => (
						<li
							key={m.seq}
							className={cn("flex flex-wrap items-center gap-2")}
							style={{ fontSize: "var(--mfw-text-2xs)" }}
						>
							<span style={{ color: "var(--mfw-fg-faint)" }}>seq {m.seq}</span>
							<span>{humanizeToken(m.type)}</span>
							<RelativeTime value={m.ts} />
							<span style={{ color: "var(--mfw-fg-muted)" }}>
								{summarizePayload(m.payload)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
