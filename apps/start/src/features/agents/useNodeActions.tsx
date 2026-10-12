import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { patchActiveActivity } from "../../lib/live";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import { type RouterInputs, type RouterOutputs, useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import type { TranscriptItem } from "../transcript/entries";
import {
	approvalSettled,
	markGroupWinner,
	markRunStopping,
	type RunCapabilities,
	type RunControlState,
	type RunMoves,
	restoreRunSnapshot,
	runControlState,
	runMoves,
} from "./runControls";

/**
 * THE way to act on a node: stop, steer, pause, resume, answer, reroute for
 * a run; select a winner, add an attempt, stop all for a group; pause, resume
 * and stop for a task. Every surface (the card, the dock row, the inspector
 * header, the run page) goes through here, so an action is patched, rolled
 * back and toasted the same way wherever it was pressed, and the server's
 * refusal text (`data.fix`) reaches the person the same way too.
 *
 * `useRunControls` is the run slice of this hook.
 *
 * There is no separate "interrupt the turn" control: `RunEngine` exposes no
 * turn-only interrupt, and a one-shot driver ends the run when its turn is
 * interrupted. Stop already asks the harness to interrupt first
 * (`gracefulStop`) and steer interrupts-and-redirects where the driver can.
 *
 * Optimistic state: stop, pause, reroute and select-winner patch the cached
 * run, group and Flow nodes and roll back on a refusal. Pause and resume of
 * a task, add attempt and resume of a run have no state to patch before the
 * daemon answers (they create a hold or a new run), so they only invalidate.
 */

export interface RunControlTarget {
	project: string;
	runId: string;
	label: string;
	state: string;
	capabilities: RunCapabilities | null | undefined;
}

export type NodeActionTarget =
	| ({ kind: "run" } & RunControlTarget)
	| {
			kind: "group";
			project: string;
			groupId: string;
			taskId: string;
			label?: string;
			/** The attempts that still have a process: what "Stop all" stops. */
			liveRunIds: readonly string[];
	  }
	| {
			kind: "task";
			project: string;
			taskId: string;
			label?: string;
			liveRunIds: readonly string[];
	  };

export type ApprovalDecision =
	| "accept"
	| "acceptForSession"
	| "decline"
	| "cancel";

type RerouteInput = Omit<RouterInputs["runs"]["reroute"], "project" | "runId">;
type AddAttemptInput = Omit<
	RouterInputs["groups"]["addAttempt"],
	"project" | "groupId"
>;
type AnswerResult = RouterOutputs["clarify"]["answer"];

export interface RunControls extends RunControlState {
	stop: {
		/** Ask for confirmation (opens `StopRunDialog`). */
		request: () => void;
		confirmOpen: boolean;
		setConfirmOpen: (open: boolean) => void;
		/** Send the stop. Prefer `request`; the dialog calls this. */
		confirm: () => void;
		pending: boolean;
	};
	steer: {
		send: (message: string, opts?: { onSent?: () => void }) => void;
		pending: boolean;
	};
	approval: {
		/** The request whose answer is in flight; its buttons stay disabled. */
		respondingId: string | null;
		respond: (requestId: string, decision: ApprovalDecision) => void;
		/** Clear `respondingId` once the transcript shows the request resolved. */
		settle: (items: readonly TranscriptItem[]) => void;
	};
	/** Which of pause, resume and reroute this run's state allows. */
	moves: RunMoves;
	/** Stop and keep the worktree; Resume continues it. */
	pause: { send: () => void; pending: boolean };
	/** Continue a settled run on its own route. */
	resume: { send: () => void; pending: boolean };
	/** Stop (if live), then continue on another harness, model or host. */
	reroute: {
		open: boolean;
		setOpen: (open: boolean) => void;
		send: (input: RerouteInput) => void;
		pending: boolean;
		/** The server's refusal, with its fix, while the dialog is open. */
		error: string | null;
	};
	/** The run's open question, answered (the agent resumes in its worktree). */
	answer: {
		send: (
			text: string,
			opts?: {
				onResult?: (result: AnswerResult) => void;
			},
		) => void;
		pending: boolean;
	};
}

export interface GroupActions {
	selectWinner: {
		send: (runId: string, reason?: string) => void;
		pending: boolean;
		/** The run being selected while the request is in flight. */
		runId: string | null;
		/** The server's refusal text (with its fix) for the last attempt, until the next try. */
		error: string | null;
	};
	addAttempt: {
		open: boolean;
		setOpen: (open: boolean) => void;
		send: (input: AddAttemptInput) => void;
		pending: boolean;
		error: string | null;
	};
	stopAll: {
		request: () => void;
		confirmOpen: boolean;
		setConfirmOpen: (open: boolean) => void;
		confirm: () => void;
		pending: boolean;
		count: number;
	};
}

export interface TaskActions {
	pause: { send: (reason?: string) => void; pending: boolean };
	resume: { send: () => void; pending: boolean };
	stopAll: GroupActions["stopAll"];
}

export interface NodeActions {
	run: RunControls;
	group: GroupActions;
	task: TaskActions;
}

/** The text of a failed request with the server's remedy appended. */
export function refusalText(error: unknown): string {
	const e = error as {
		message?: string;
		data?: { fix?: { text?: unknown } | null };
	};
	const fix = e?.data?.fix?.text;
	const base = e?.message ?? "The request was refused";
	return typeof fix === "string" && fix ? `${base}. Fix: ${fix}` : base;
}

export function useNodeActions(target: NodeActionTarget): NodeActions {
	const project = target.project;
	const runTarget = target.kind === "run" ? target : null;
	const runId = runTarget?.runId ?? "";
	const label = runTarget?.label ?? target.label ?? "";
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const go = useGo();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [respondingId, setRespondingId] = useState<string | null>(null);
	const [rerouteOpen, setRerouteOpen] = useState(false);
	const [rerouteError, setRerouteError] = useState<string | null>(null);
	const [groupStopOpen, setGroupStopOpen] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);
	const [pickError, setPickError] = useState<string | null>(null);
	const [picking, setPicking] = useState<string | null>(null);

	const refreshRun = (id: string) => {
		void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
		void queryClient.invalidateQueries(
			trpc.runs.get.queryFilter({ project, runId: id }),
		);
	};
	const refreshFlow = () => {
		void queryClient.invalidateQueries(trpc.flow.tree.queryFilter({ project }));
		void queryClient.invalidateQueries(trpc.flow.live.queryFilter({ project }));
	};

	// One stop mutation, whichever node it was pressed on: the optimistic
	// patch is keyed on the run in the variables, so "stop all" is N of these.
	const stop = useMutation(
		trpc.runs.stop.mutationOptions({
			meta: { label: "Stop run" },
			onMutate: async (vars) => {
				await queryClient.cancelQueries(trpc.runs.active.queryFilter());
				await queryClient.cancelQueries(
					trpc.runs.get.queryFilter({ project, runId: vars.runId }),
				);
				return {
					snapshot: markRunStopping(queryClient, trpc, project, vars.runId),
				};
			},
			onError: (_err, _vars, ctx) => {
				restoreRunSnapshot(queryClient, ctx?.snapshot);
			},
			onSettled: (_data, _err, vars) => refreshRun(vars.runId),
		}),
	);
	const stopRun = (id: string, onSuccess?: () => void) =>
		stop.mutate({ project, runId: id }, onSuccess ? { onSuccess } : {});

	const steer = useMutation(
		trpc.runs.steer.mutationOptions({
			meta: { label: "Steer" },
			onSuccess: () => {
				// The daemon reports a new activity only once the agent's next event
				// lands; until then an "idle" or "question" chip would be stale.
				patchActiveActivity(queryClient, trpc, project, runId, "working");
				toast({
					tone: "success",
					title: "Steer delivered",
					description: "Waiting for the agent to pick it up.",
				});
			},
		}),
	);

	const respond = useMutation(
		trpc.runs.respondApproval.mutationOptions({
			meta: { label: "Respond to approval" },
			onMutate: ({ requestId }) => setRespondingId(requestId),
			onSuccess: () =>
				toast({ tone: "success", title: "Approval response delivered" }),
			onError: () => setRespondingId(null),
		}),
	);

	const settle = useCallback((items: readonly TranscriptItem[]) => {
		setRespondingId((current) =>
			current && approvalSettled(items, current) ? null : current,
		);
	}, []);

	const answer = useMutation(
		trpc.clarify.answer.mutationOptions({
			meta: { label: "Answer" },
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.clarify.open.queryFilter());
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
				void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
			},
		}),
	);

	const reroute = useMutation(
		trpc.runs.reroute.mutationOptions({
			meta: { label: "Reroute run" },
			onMutate: async (vars) => {
				setRerouteError(null);
				await queryClient.cancelQueries(trpc.runs.active.queryFilter());
				// Only a live run is stopped by the request; a settled one is not patched.
				const live = runTarget?.state === "running";
				return {
					snapshot: live
						? markRunStopping(queryClient, trpc, project, vars.runId)
						: [],
				};
			},
			onError: (err, _vars, ctx) => {
				restoreRunSnapshot(queryClient, ctx?.snapshot);
				setRerouteError(refusalText(err));
			},
			onSuccess: (out) => {
				setRerouteOpen(false);
				toast({
					tone: "success",
					title: `Continuing ${label || out.stoppedRunId} on a new route`,
					action: {
						label: "Open the run",
						onClick: () => go(href.run(project, out.runId)),
					},
				});
			},
			onSettled: (_data, _err, vars) => {
				refreshRun(vars.runId);
				refreshFlow();
				void queryClient.invalidateQueries(
					trpc.runs.list.queryFilter({ project }),
				);
			},
		}),
	);

	const selectWinner = useMutation(
		trpc.groups.selectWinner.mutationOptions({
			meta: { label: "Select winner" },
			onMutate: async (vars) => {
				setPickError(null);
				setPicking(vars.runId);
				await queryClient.cancelQueries(
					trpc.groups.get.queryFilter({ project, groupId: vars.groupId }),
				);
				await queryClient.cancelQueries(
					trpc.flow.tree.queryFilter({ project }),
				);
				return {
					snapshot: markGroupWinner(
						queryClient,
						trpc,
						project,
						vars.groupId,
						vars.runId,
					),
				};
			},
			onError: (err, _vars, ctx) => {
				restoreRunSnapshot(queryClient, ctx?.snapshot);
				setPickError(refusalText(err));
			},
			onSuccess: () => {
				toast({
					tone: "success",
					title: "Winner selected",
					description: "It goes through the gates to the merge queue.",
				});
			},
			onSettled: (_data, _err, vars) => {
				setPicking(null);
				void queryClient.invalidateQueries(
					trpc.groups.get.queryFilter({ project, groupId: vars.groupId }),
				);
				refreshFlow();
				if (target.kind === "group") {
					void queryClient.invalidateQueries(
						trpc.node.story.queryFilter({
							project,
							ref: `task:${target.taskId}`,
						}),
					);
				}
			},
		}),
	);

	const addAttempt = useMutation(
		trpc.groups.addAttempt.mutationOptions({
			meta: { label: "Add attempt" },
			onMutate: () => setAddError(null),
			onError: (err) => setAddError(refusalText(err)),
			onSuccess: (out) => {
				setAddOpen(false);
				toast({
					tone: "success",
					title: "Attempt added",
					action: {
						label: "Open the run",
						onClick: () => go(href.run(project, out.runId)),
					},
				});
			},
			onSettled: (_data, _err, vars) => {
				void queryClient.invalidateQueries(
					trpc.groups.get.queryFilter({ project, groupId: vars.groupId }),
				);
				refreshFlow();
				void queryClient.invalidateQueries(trpc.runs.active.queryFilter());
			},
		}),
	);

	const pauseTask = useMutation(
		trpc.holds.pause.mutationOptions({
			meta: { label: "Pause task" },
			onSuccess: () => toast({ tone: "success", title: "Paused" }),
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.holds.list.queryFilter({ project }),
				);
			},
		}),
	);
	const resumeTask = useMutation(
		trpc.holds.resume.mutationOptions({
			meta: { label: "Resume task" },
			onSuccess: () => toast({ tone: "success", title: "Resumed" }),
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.holds.list.queryFilter({ project }),
				);
			},
		}),
	);

	const moves = runMoves(runTarget?.state ?? "");

	const run: RunControls = {
		...runControlState({
			state: runTarget?.state ?? "unknown",
			capabilities: runTarget?.capabilities,
		}),
		stop: {
			request: () => setConfirmOpen(true),
			confirmOpen,
			setConfirmOpen,
			confirm: () =>
				stopRun(runId, () => {
					setConfirmOpen(false);
					toast({ tone: "success", title: `Stopping ${label}` });
				}),
			pending: stop.isPending,
		},
		steer: {
			send: (message, opts) => {
				const text = message.trim();
				if (!text) return;
				steer.mutate(
					{ project, runId, message: text },
					{ onSuccess: () => opts?.onSent?.() },
				);
			},
			pending: steer.isPending,
		},
		approval: {
			respondingId,
			respond: (requestId, decision) =>
				respond.mutate({ project, runId, requestId, decision }),
			settle,
		},
		moves,
		pause: {
			send: () =>
				stopRun(runId, () =>
					toast({
						tone: "success",
						title: `Paused ${label}`,
						description: "The worktree is kept. Resume continues it.",
					}),
				),
			pending: stop.isPending,
		},
		resume: {
			send: () => reroute.mutate({ project, runId, keepRoute: true }),
			pending: reroute.isPending,
		},
		reroute: {
			open: rerouteOpen,
			setOpen: (open) => {
				setRerouteOpen(open);
				if (!open) setRerouteError(null);
			},
			send: (input) => reroute.mutate({ project, runId, ...input }),
			pending: reroute.isPending,
			error: rerouteError,
		},
		answer: {
			send: (text, opts) => {
				const trimmed = text.trim();
				if (!trimmed) return;
				answer.mutate(
					{
						project,
						runId,
						answers: [{ index: 0, answer: trimmed }],
						continuePlanning: true,
					},
					{ onSuccess: (result) => opts?.onResult?.(result) },
				);
			},
			pending: answer.isPending,
		},
	};

	const liveIds = target.kind === "run" ? [] : target.liveRunIds;
	const stopAll: GroupActions["stopAll"] = {
		request: () => setGroupStopOpen(true),
		confirmOpen: groupStopOpen,
		setConfirmOpen: setGroupStopOpen,
		confirm: () => {
			for (const id of liveIds) stopRun(id);
			setGroupStopOpen(false);
			toast({
				tone: "success",
				title: `Stopping ${liveIds.length} run${liveIds.length === 1 ? "" : "s"}`,
			});
		},
		pending: stop.isPending,
		count: liveIds.length,
	};

	const group: GroupActions = {
		selectWinner: {
			send: (pickId, reason) => {
				if (target.kind !== "group") return;
				selectWinner.mutate({
					project,
					groupId: target.groupId,
					runId: pickId,
					...(reason ? { reason } : {}),
				});
			},
			pending: selectWinner.isPending,
			runId: picking,
			error: pickError,
		},
		addAttempt: {
			open: addOpen,
			setOpen: (open) => {
				setAddOpen(open);
				if (!open) setAddError(null);
			},
			send: (input) => {
				if (target.kind !== "group") return;
				addAttempt.mutate({ project, groupId: target.groupId, ...input });
			},
			pending: addAttempt.isPending,
			error: addError,
		},
		stopAll,
	};

	const task: TaskActions = {
		pause: {
			send: (reason) => {
				if (target.kind !== "task") return;
				pauseTask.mutate({
					project,
					taskIds: [target.taskId],
					...(reason ? { reason } : {}),
				});
			},
			pending: pauseTask.isPending,
		},
		resume: {
			send: () => {
				if (target.kind !== "task") return;
				resumeTask.mutate({ project, taskIds: [target.taskId] });
			},
			pending: resumeTask.isPending,
		},
		stopAll,
	};

	return { run, group, task };
}

/** The run slice of `useNodeActions`, for every surface that only handles a run. */
export function useRunControls(target: RunControlTarget): RunControls {
	return useNodeActions({ kind: "run", ...target }).run;
}

/** The one stop confirmation, worded from what the harness can do. */
export function StopRunDialog({
	controls,
	target,
}: {
	controls: Pick<RunControls, "stop" | "gracefulStop">;
	target: Pick<RunControlTarget, "label" | "runId">;
}) {
	return (
		<ConfirmDialog
			open={controls.stop.confirmOpen}
			onOpenChange={controls.stop.setConfirmOpen}
			title={`Stop ${target.label}?`}
			description={
				<>
					{controls.gracefulStop
						? "The harness is asked to interrupt the active turn cleanly. If it does not acknowledge in time, mfw stops the process. "
						: "The agent process is stopped. "}
					Work already committed on <Mono value={target.runId} truncate={8} />{" "}
					is kept and the run is finalized as interrupted; nothing is merged.
				</>
			}
			confirmLabel="Stop run"
			pending={controls.stop.pending}
			onConfirm={controls.stop.confirm}
		/>
	);
}

/** "Stop all" for a group or a task: every live attempt, one confirmation. */
export function StopAllDialog({
	actions,
	title,
}: {
	actions: GroupActions["stopAll"];
	title: string;
}) {
	return (
		<ConfirmDialog
			open={actions.confirmOpen}
			onOpenChange={actions.setConfirmOpen}
			title={title}
			description={
				<>
					{actions.count} live run{actions.count === 1 ? "" : "s"} will be
					stopped. Work already committed is kept; nothing is merged.
				</>
			}
			confirmLabel={`Stop ${actions.count} run${actions.count === 1 ? "" : "s"}`}
			pending={actions.pending}
			onConfirm={actions.confirm}
		/>
	);
}
