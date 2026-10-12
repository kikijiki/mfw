import { useQuery } from "@tanstack/react-query";
import { Pause, Play, Square } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useTRPC } from "../../lib/trpc";
import { StopAllDialog, useNodeActions } from "../agents/useNodeActions";

/**
 * The task's moves in the inspector header (design §10.1): Pause and Resume
 * (a hold neither the scheduler nor the brain starts runs through), and Stop
 * all when the task has live runs. Built on `useNodeActions`, so each is
 * recorded as a human decision.
 */
export function TaskActions({
	project,
	taskId,
}: {
	project: string;
	taskId: string;
}) {
	const trpc = useTRPC();
	const holds = useQuery(trpc.holds.list.queryOptions({ project }));
	const active = useQuery(trpc.runs.active.queryOptions());
	const live = (active.data ?? [])
		.filter((r) => r.project === project && r.taskId === taskId)
		.map((r) => r.runId);
	const { task } = useNodeActions({
		kind: "task",
		project,
		taskId,
		label: taskId,
		liveRunIds: live,
	});
	const held = holds.data?.some((h) => h.taskId === taskId) ?? false;
	return (
		<>
			{live.length > 0 ? (
				<Button
					size="xs"
					variant="ghost"
					disabled={task.stopAll.pending}
					onClick={task.stopAll.request}
					title="Stop every live run of this task"
				>
					<Square aria-hidden />
					Stop all
				</Button>
			) : null}
			{held ? (
				<Button
					size="xs"
					variant="ghost"
					disabled={task.resume.pending}
					onClick={task.resume.send}
					title="Let the scheduler and the brain start runs for this task again"
				>
					<Play aria-hidden />
					Resume
				</Button>
			) : (
				<Button
					size="xs"
					variant="ghost"
					disabled={task.pause.pending}
					onClick={() => task.pause.send()}
					title="Hold this task: nothing starts a run for it until you resume"
				>
					<Pause aria-hidden />
					Pause
				</Button>
			)}
			<StopAllDialog
				actions={task.stopAll}
				title={`Stop ${live.length} live run${live.length === 1 ? "" : "s"} of ${taskId}?`}
			/>
		</>
	);
}
