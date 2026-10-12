import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LifeBuoy, Play } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AppLink } from "../../components/AppLink";
import { Mono } from "../../components/Cost";
import { ErrorState } from "../../components/ErrorState";
import { Chip, Panel } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { md } from "../../lib/markdown";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

/**
 * Escalation sessions: the brief mfw composes when its own recovery ran out
 * (`SessionService.raise`, packages/daemon/src/session.ts: a parked merge, a
 * red main that kept failing, a task released to blocked). It costs nothing
 * until a human starts it, which launches an agent seeded with the brief; it
 * leaves the list only when resolved with a disposition.
 */

type OpenSession = RouterOutputs["sessions"]["open"][number];
export type Resolution = "fixed" | "retried" | "dismissed";

export const SOURCE_LABEL: Record<OpenSession["source"], string> = {
	main_red: "main is red",
	merge_parked: "merge parked",
	blocked: "task blocked",
};

/** Mirrors `SessionService.resolve`: dismissing needs a reason, the others do not. */
export function resolveProblem(
	resolution: Resolution,
	reason: string,
): string | null {
	return resolution === "dismissed" && reason.trim().length === 0
		? "Say why it is dismissed."
		: null;
}

/** Every open session across projects, newest first; nothing when there are none. */
export function EscalationsPanel() {
	const trpc = useTRPC();
	const open = useQuery(trpc.sessions.open.queryOptions());
	if (open.error) {
		return (
			<ErrorState
				title="Could not load escalations"
				error={open.error}
				onRetry={() => void open.refetch()}
			/>
		);
	}
	const sessions = open.data ?? [];
	if (sessions.length === 0) return null;
	return (
		<section aria-label="Escalations" className="flex flex-col gap-2">
			<h2
				className="flex items-center gap-1.5 font-medium"
				style={{ fontSize: "var(--mfw-text-md)" }}
			>
				<LifeBuoy
					aria-hidden
					className="size-4"
					style={{ color: "var(--mfw-critical)" }}
				/>
				Escalations
				<Chip tone="critical">{sessions.length}</Chip>
			</h2>
			{sessions.map((s) => (
				<SessionCard key={`${s.project}/${s.id}`} session={s} />
			))}
		</section>
	);
}

export function SessionCard({ session }: { session: OpenSession }) {
	const trpc = useTRPC();
	const { toast } = useToast();
	const [briefOpen, setBriefOpen] = useState(false);
	const [resolving, setResolving] = useState<Resolution | null>(null);
	const [reason, setReason] = useState("");
	const project = session.project;

	const start = useMutation(
		trpc.sessions.start.mutationOptions({
			meta: { label: "Start session" },
			onSuccess: () =>
				toast({
					tone: "success",
					title: "Session started",
					description: "An agent is working from the brief.",
				}),
		}),
	);
	const resolve = useMutation(
		trpc.sessions.resolve.mutationOptions({
			meta: { label: "Resolve session" },
			onSuccess: () => {
				setResolving(null);
				setReason("");
				toast({ tone: "success", title: "Session resolved" });
			},
		}),
	);

	const runId = session.openedRunId ?? start.data?.runId ?? null;
	const problem = resolving ? resolveProblem(resolving, reason) : null;

	return (
		<Panel style={{ borderColor: "var(--mfw-critical)" }}>
			<div className="flex flex-col gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Chip>{project}</Chip>
					<Chip tone="critical">{SOURCE_LABEL[session.source]}</Chip>
					<span className="min-w-0 flex-1 truncate font-medium">
						{session.title}
					</span>
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						<RelativeTime value={session.createdAt} />
					</span>
				</div>
				<div
					className="flex flex-wrap items-center gap-x-3 gap-y-1"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{session.taskId ? (
						<AppLink to={href.task(project, session.taskId)}>
							task <Mono value={session.taskId} />
						</AppLink>
					) : null}
					{session.runId ? (
						<AppLink to={href.run(project, session.runId)}>
							failed run <Mono value={session.runId} truncate={8} />
						</AppLink>
					) : null}
					{runId ? (
						<AppLink to={href.run(project, runId)}>
							session agent <Mono value={runId} truncate={8} />
						</AppLink>
					) : null}
				</div>

				<button
					type="button"
					aria-expanded={briefOpen}
					onClick={() => setBriefOpen((v) => !v)}
					className="mfw-focus flex items-center gap-1 self-start border-0 bg-transparent p-0"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{briefOpen ? (
						<ChevronDown aria-hidden className="size-3" />
					) : (
						<ChevronRight aria-hidden className="size-3" />
					)}
					{briefOpen ? "Hide the brief" : "Read the brief"}
				</button>
				{briefOpen ? (
					<div
						className="max-h-96 overflow-auto px-2"
						style={{
							background: "var(--mfw-bg-inset)",
							borderRadius: "var(--mfw-radius-sm)",
						}}
					>
						<ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>
							{session.context}
						</ReactMarkdown>
					</div>
				) : null}

				<div className="flex flex-wrap items-center gap-2">
					{runId ? null : (
						<Button
							size="sm"
							disabled={start.isPending}
							onClick={() => start.mutate({ project, id: session.id })}
							title="Launch an agent seeded with this brief (starts costing)"
						>
							<Play aria-hidden />
							{start.isPending ? "Starting…" : "Start session"}
						</Button>
					)}
					<span className="flex-1" />
					{(["fixed", "retried", "dismissed"] as const).map((r) => (
						<Button
							key={r}
							size="sm"
							variant={resolving === r ? "secondary" : "outline"}
							aria-pressed={resolving === r}
							onClick={() => setResolving(resolving === r ? null : r)}
						>
							{r === "fixed"
								? "Fixed"
								: r === "retried"
									? "Retried"
									: "Dismiss"}
						</Button>
					))}
				</div>

				{resolving ? (
					<form
						className="flex flex-col gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (problem) return;
							resolve.mutate({
								project,
								id: session.id,
								resolution: resolving,
								reason: reason.trim() || undefined,
							});
						}}
					>
						<Textarea
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							placeholder={
								resolving === "dismissed"
									? "Why is this not worth acting on? (required)"
									: "What was done (optional)"
							}
							aria-label="Resolution note"
							rows={2}
						/>
						<div className="flex items-center gap-2">
							{problem ? (
								<span
									style={{
										color: "var(--mfw-warn)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									{problem}
								</span>
							) : null}
							<span className="flex-1" />
							<Button
								type="submit"
								size="sm"
								disabled={problem !== null || resolve.isPending}
							>
								{resolve.isPending ? "Resolving…" : `Resolve as ${resolving}`}
							</Button>
						</div>
					</form>
				) : null}
			</div>
		</Panel>
	);
}
