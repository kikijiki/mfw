import { useQuery } from "@tanstack/react-query";
import { GitBranchPlus, Pause, Play } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useTRPC } from "../../lib/trpc";
import { RerouteDialog } from "./RerouteDialog";
import type { RunControls, RunControlTarget } from "./useNodeActions";

/**
 * Pause, Resume and Reroute for one run, from the controls `useNodeActions`
 * built (design §10.1). Which of them show is `controls.moves`; Reroute opens
 * the route picker, whose current route is read from the run only while the
 * dialog is open.
 */
export function RunMoves({
	target,
	controls,
	size = "sm",
}: {
	target: Pick<RunControlTarget, "project" | "runId" | "label" | "state">;
	controls: RunControls;
	size?: "xs" | "sm";
}) {
	const trpc = useTRPC();
	const run = useQuery({
		...trpc.runs.get.queryOptions({
			project: target.project,
			runId: target.runId,
		}),
		enabled: controls.reroute.open,
	});
	const { moves } = controls;
	if (!moves.pause && !moves.resume && !moves.reroute) return null;
	return (
		<>
			{moves.pause ? (
				<Button
					size={size}
					variant="outline"
					disabled={controls.pause.pending}
					title="Stop the run and keep its worktree; Resume continues it"
					onClick={controls.pause.send}
				>
					<Pause aria-hidden />
					Pause
				</Button>
			) : null}
			{moves.resume ? (
				<Button
					size={size}
					variant="outline"
					disabled={controls.resume.pending}
					title="Continue in this run's worktree on its own route"
					onClick={controls.resume.send}
				>
					<Play aria-hidden />
					Resume
				</Button>
			) : null}
			{moves.reroute ? (
				<Button
					size={size}
					variant="outline"
					title="Continue on another harness, model or host"
					onClick={() => controls.reroute.setOpen(true)}
				>
					<GitBranchPlus aria-hidden />
					Reroute…
				</Button>
			) : null}
			<RerouteDialog
				open={controls.reroute.open}
				onOpenChange={controls.reroute.setOpen}
				label={target.label}
				live={target.state === "running"}
				current={{
					harness: run.data?.harness ?? run.data?.providerId ?? null,
					model: run.data?.model ?? null,
					hostId: run.data?.hostId ?? null,
				}}
				pending={controls.reroute.pending}
				error={controls.reroute.error}
				onSubmit={(pick) => controls.reroute.send(pick)}
			/>
		</>
	);
}
