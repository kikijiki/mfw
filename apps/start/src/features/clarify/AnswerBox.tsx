import { useQuery } from "@tanstack/react-query";
import { CircleHelp, Send } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AppLink } from "../../components/AppLink";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { useRunControls } from "../agents/useRunControls";
import { ClarifyDialog } from "./ClarifyDialog";

type OpenSet = RouterOutputs["clarify"]["open"][number];

/** The clarification kind a task run's own question is recorded under (daemon `TASK_QUESTION_KIND`). */
export const TASK_QUESTION_KIND = "task";

/**
 * How a question set is answered here: a task run's single question inline
 * (answering resumes the agent in its worktree), anything else through the
 * full dialog (planner sets, several questions, a re-plan to confirm).
 */
export function answerMode(set: {
	kind: string;
	items: readonly { answer: string | null }[];
}): "inline" | "dialog" {
	return set.kind === TASK_QUESTION_KIND && set.items.length === 1
		? "inline"
		: "dialog";
}

/**
 * The open question a run left, answerable where the run is shown (NOW, the
 * dock's console, the run page). Reads the shared `clarify.open` cache, so it
 * adds no request; renders nothing when the run has no open question.
 */
export function AnswerBox({
	project,
	runId,
	set: given,
}: {
	project: string;
	runId: string;
	/** Already-fetched set (NOW lists them); otherwise looked up in `clarify.open`. */
	set?: OpenSet;
}) {
	const trpc = useTRPC();
	const questions = useQuery({
		...trpc.clarify.open.queryOptions(),
		enabled: given === undefined,
	});
	const set =
		given ??
		questions.data?.find((q) => q.project === project && q.runId === runId);
	if (!set) return null;
	return answerMode(set) === "inline" ? (
		<InlineAnswer project={project} set={set} />
	) : (
		<DialogAnswer project={project} set={set} />
	);
}

function Strip({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="flex flex-col gap-1.5 px-2 py-1.5"
			style={{
				background: "color-mix(in oklch, var(--mfw-warn) 12%, transparent)",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			{children}
		</div>
	);
}

function DialogAnswer({ project, set }: { project: string; set: OpenSet }) {
	const [open, setOpen] = useState(false);
	return (
		<Strip>
			<div className="flex flex-wrap items-center gap-2">
				<CircleHelp
					aria-hidden
					className="size-3.5 shrink-0"
					style={{ color: "var(--mfw-warn)" }}
				/>
				<span className="min-w-0 flex-1">
					{set.openCount} open question{set.openCount === 1 ? "" : "s"} from
					this run.
				</span>
				<Button size="xs" variant="outline" onClick={() => setOpen(true)}>
					Answer
				</Button>
			</div>
			<ClarifyDialog
				project={project}
				runId={set.runId}
				open={open}
				onOpenChange={setOpen}
			/>
		</Strip>
	);
}

function InlineAnswer({ project, set }: { project: string; set: OpenSet }) {
	const { toast } = useToast();
	const go = useGo();
	const id = useId();
	const item = set.items[0];
	const [text, setText] = useState(item?.answer ?? "");
	const [failure, setFailure] = useState<string | null>(null);
	// The answer mutation is built once, in `useNodeActions`.
	const { answer } = useRunControls({
		project,
		runId: set.runId,
		label: set.runId,
		state: "running",
		capabilities: null,
	});

	if (!item) return null;
	return (
		<Strip>
			<label htmlFor={id} className="flex items-start gap-2">
				<CircleHelp
					aria-hidden
					className="mt-0.5 size-3.5 shrink-0"
					style={{ color: "var(--mfw-warn)" }}
				/>
				<span
					className="min-w-0 flex-1 whitespace-pre-wrap"
					style={{ lineHeight: "var(--mfw-leading-prose)" }}
				>
					{item.question}
				</span>
			</label>
			<form
				className="flex items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					setFailure(null);
					answer.send(text, {
						onResult: (result) => {
							if (result.continuation.status === "failed") {
								setFailure(result.continuation.message);
								return;
							}
							if (result.continuation.status === "started") {
								const childRunId = result.continuation.runId;
								toast({
									tone: "success",
									title: "Resuming the agent with your answer",
									action: {
										label: "Open the run",
										onClick: () => go(href.run(project, childRunId)),
									},
								});
							}
						},
					});
				}}
			>
				<Textarea
					id={id}
					rows={2}
					value={text}
					disabled={answer.pending}
					placeholder="Your answer. The agent resumes in its worktree with it."
					onChange={(e) => setText(e.target.value)}
				/>
				<Button
					type="submit"
					size="sm"
					disabled={answer.pending || text.trim().length === 0}
				>
					<Send aria-hidden />
					{answer.pending ? "Resuming…" : "Answer and resume"}
				</Button>
			</form>
			{failure ? (
				<p role="alert" style={{ color: "var(--mfw-warn)" }}>
					<strong>Your answer is saved.</strong> The agent did not resume:{" "}
					{failure}. Submit again to retry, or{" "}
					<AppLink to={href.run(project, set.runId)}>see the run</AppLink>.
				</p>
			) : null}
		</Strip>
	);
}
