import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

/** Answers a planner's clarify questions. Opens from the inbox because `clarify.open` is cross-project. */

type Clarification = NonNullable<RouterOutputs["clarify"]["get"]>;

export function parseSavedClarificationDrafts(
	raw: string | null,
	expectedLength: number,
): string[] | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!Array.isArray(parsed) ||
			parsed.length !== expectedLength ||
			!parsed.every((value) => typeof value === "string")
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function mergeClarificationDrafts(
	server: string[],
	local: string[],
): string[] {
	return server.map((value, index) =>
		value.trim() ? value : (local[index] ?? ""),
	);
}

export function ClarifyDialog({
	project,
	runId,
	open,
	onOpenChange,
}: {
	project: string;
	runId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const trpc = useTRPC();
	const set = useQuery({
		...trpc.clarify.get.queryOptions({ project, runId }),
		enabled: open,
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="mfw-v2 sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex flex-wrap items-center gap-2">
						<Chip>{project}</Chip>
						Questions before planning
					</DialogTitle>
					<DialogDescription>
						An agent stopped rather than guess. What you write here is fed back
						to it verbatim.
					</DialogDescription>
				</DialogHeader>

				{set.isLoading ? (
					<LoadingRows rows={3} />
				) : set.error ? (
					<ErrorState
						title="Could not load these questions"
						error={set.error}
						onRetry={() => void set.refetch()}
					/>
				) : !set.data ? (
					<Empty
						title="These questions are gone."
						description="The set was answered or dismissed somewhere else. Nothing here is blocked on you any more."
					/>
				) : (
					// Keyed by run so a different set does not inherit half-typed answers;
					// the form seeds once on mount, so refetches cannot overwrite typing.
					<ClarifyForm
						key={runId}
						project={project}
						clarification={set.data}
						onDone={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ClarifyForm({
	project,
	clarification,
	onDone,
}: {
	project: string;
	clarification: Clarification;
	onDone: () => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const go = useGo();
	const { toast } = useToast();
	const [drafts, setDrafts] = useState(() =>
		clarification.items.map((i) => i.answer ?? ""),
	);
	const [storageLoaded, setStorageLoaded] = useState(false);
	const [continuationFailure, setContinuationFailure] = useState<string | null>(
		null,
	);
	const [confirmingArchive, setConfirmingArchive] = useState(false);

	const runId = clarification.runId;
	const storageKey = `mfw:clarify:${project}:${runId}`;
	const questionCount = clarification.items.length;
	const answered = drafts.filter((d) => d.trim() !== "").length;
	const complete = answered === clarification.items.length;
	/** No goal (importer questions) means nothing to re-plan; `clarify.answer` returns `not_requested`. */
	const replannable = clarification.goal !== null;

	// Browser draft for text typed before it reaches the server (reload, dropped
	// connection, closed dialog). Loaded in an effect to keep the first render SSR-stable.
	useEffect(() => {
		try {
			const saved = parseSavedClarificationDrafts(
				localStorage.getItem(storageKey),
				questionCount,
			);
			if (saved) {
				setDrafts((current) => mergeClarificationDrafts(current, saved));
			}
		} catch {
			// Storage is a convenience; privacy modes may deny it.
		} finally {
			setStorageLoaded(true);
		}
	}, [storageKey, questionCount]);
	useEffect(() => {
		// Don't overwrite the saved draft with the server seed before it has loaded.
		if (!storageLoaded) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify(drafts));
		} catch {
			// See above.
		}
	}, [drafts, storageKey, storageLoaded]);

	const invalidate = () => {
		void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
		void queryClient.invalidateQueries(trpc.clarify.open.queryFilter());
		void queryClient.invalidateQueries(
			trpc.clarify.get.queryFilter({ project, runId }),
		);
		void queryClient.invalidateQueries(
			trpc.tasks.list.queryFilter({ project }),
		);
		if (clarification.draftTaskId) {
			void queryClient.invalidateQueries(
				trpc.tasks.get.queryFilter({
					project,
					id: clarification.draftTaskId,
				}),
			);
		}
		void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
	};

	const answer = useMutation(
		trpc.clarify.answer.mutationOptions({
			meta: { label: "Answer" },
			onMutate: () => setContinuationFailure(null),
			onSuccess: (result) => {
				invalidate();
				if (result.continuation.status === "failed") {
					setContinuationFailure(result.continuation.message);
					toast({
						tone: "error",
						title: "Answers saved; expansion did not start",
						description: result.continuation.message,
						duration: 0,
					});
					return;
				}
				try {
					localStorage.removeItem(storageKey);
				} catch {
					// Server has the answers.
				}
				onDone();
				if (result.continuation.status === "started") {
					void queryClient.invalidateQueries(
						trpc.runs.list.queryFilter({ project }),
					);
					void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
					toast({
						tone: "success",
						title: "Re-planning with your answers",
					});
					// Show the transcript: answering just started a real agent run.
					go(href.run(project, result.continuation.runId));
					return;
				}
				const open = result.clarification.openCount;
				toast({
					tone: "success",
					title: open === 0 ? "Questions answered" : "Answers saved",
					description:
						open === 0
							? undefined
							: `${open} question${open === 1 ? "" : "s"} still unanswered.`,
				});
			},
			onSettled: invalidate,
		}),
	);

	const dismiss = useMutation(
		trpc.clarify.dismiss.mutationOptions({
			meta: { label: "Dismiss questions" },
			onSuccess: () => {
				invalidate();
				onDone();
				toast({
					tone: "info",
					title: "Questions closed unanswered",
					description: "Nothing was re-planned.",
				});
			},
			onSettled: invalidate,
		}),
	);

	const archiveDraft = useMutation(
		trpc.clarify.archiveDraft.mutationOptions({
			meta: { label: "Archive draft" },
			onSuccess: (result) => {
				invalidate();
				try {
					localStorage.removeItem(storageKey);
				} catch {
					// Already durable on the server.
				}
				setConfirmingArchive(false);
				onDone();
				toast({
					tone: "info",
					title: `${result.task.id} archived`,
					description: "Its questions were closed; expansion will not restart.",
				});
			},
			onSettled: invalidate,
		}),
	);

	const pending =
		answer.isPending || dismiss.isPending || archiveDraft.isPending;
	const interactionLocked = pending || confirmingArchive;

	/** Sends every question at its current text; the server treats blank as unanswered (and this satisfies the input's `min(1)`). */
	const submit = (continuePlanning: boolean) =>
		answer.mutate({
			project,
			runId,
			answers: drafts.map((value, index) => ({ index, answer: value })),
			continuePlanning,
		});

	return (
		<>
			{clarification.goal ? (
				<div className="flex flex-col gap-1">
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						the goal these questions are about
					</span>
					<p
						className="border-l-2 pl-2"
						style={{
							borderColor: "var(--mfw-border)",
							color: "var(--mfw-fg-muted)",
							lineHeight: "var(--mfw-leading-prose)",
						}}
					>
						{clarification.goal}
					</p>
				</div>
			) : null}

			<div className="flex max-h-100 flex-col gap-3 overflow-y-auto">
				{clarification.items.map((item, index) => (
					<Question
						// biome-ignore lint/suspicious/noArrayIndexKey: the set is fixed and ordered; `index` is the identity `clarify.answer` uses
						key={`${runId}:${index}`}
						question={item.question}
						value={drafts[index] ?? ""}
						disabled={interactionLocked}
						onChange={(value) =>
							setDrafts((prev) => prev.map((v, i) => (i === index ? value : v)))
						}
					/>
				))}
			</div>

			{continuationFailure ? (
				<div
					role="alert"
					className="border p-2"
					style={{
						borderColor: "var(--mfw-warn)",
						background: "color-mix(in oklch, var(--mfw-warn) 8%, transparent)",
						color: "var(--mfw-warn)",
					}}
				>
					<strong>Your answers are saved.</strong> Expansion did not start:{" "}
					{continuationFailure}. Nothing needs to be retyped; use Continue
					expansion to retry.
				</div>
			) : null}

			{confirmingArchive ? (
				<div
					role="alert"
					className="flex flex-wrap items-center gap-2 border p-2"
					style={{
						borderColor: "var(--mfw-critical)",
						background:
							"color-mix(in oklch, var(--mfw-critical) 8%, transparent)",
					}}
				>
					<p className="min-w-0 flex-1 basis-64">
						<strong>Archive this draft?</strong> Its questions will close and
						expansion will not restart. The task remains in Archived and the
						answers already saved remain in its history. Text not saved yet will
						be discarded.
					</p>
					<Button
						size="sm"
						variant="ghost"
						disabled={archiveDraft.isPending}
						onClick={() => setConfirmingArchive(false)}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="destructive"
						disabled={archiveDraft.isPending}
						onClick={() => archiveDraft.mutate({ project, runId })}
					>
						{archiveDraft.isPending ? "Archiving…" : "Archive draft"}
					</Button>
				</div>
			) : null}

			<p
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				{replannable ? (
					<>
						Incomplete answers can be saved as progress. Once every question is
						answered, <strong>Continue expansion</strong> starts exactly one
						plan run with the saved answers. If launch fails, this dialog stays
						open.
					</>
				) : (
					<>
						These questions came from an import, which has no goal to re-plan
						against, so there is nothing to start from here. Saving records the
						answers and takes the set out of the inbox.
					</>
				)}
			</p>

			<DialogFooter className="sm:justify-between">
				{replannable && clarification.draftTaskId ? (
					<Button
						variant="ghost"
						disabled={pending || confirmingArchive}
						onClick={() => setConfirmingArchive(true)}
					>
						Archive draft
					</Button>
				) : !replannable ? (
					<Button
						variant="ghost"
						disabled={interactionLocked}
						onClick={() => dismiss.mutate({ project, runId })}
					>
						Dismiss unanswered
					</Button>
				) : (
					<span />
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="ghost" asChild>
						<AppLink to={href.run(project, runId)}>See the run</AppLink>
					</Button>
					{replannable && complete ? (
						<Button
							disabled={interactionLocked || answered === 0}
							onClick={() => submit(true)}
						>
							{answer.isPending ? "Starting…" : "Continue expansion"}
						</Button>
					) : (
						<Button
							variant="outline"
							disabled={interactionLocked || answered === 0}
							onClick={() => submit(false)}
						>
							{answer.isPending
								? "Saving…"
								: replannable
									? "Save progress"
									: "Save answers"}
						</Button>
					)}
				</div>
			</DialogFooter>
		</>
	);
}

function Question({
	question,
	value,
	disabled,
	onChange,
}: {
	question: string;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} style={{ lineHeight: "var(--mfw-leading-prose)" }}>
				{question}
			</label>
			<Textarea
				id={id}
				rows={2}
				value={value}
				disabled={disabled}
				placeholder="Leave blank to keep this one open."
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}
