import { ScrollText, Send, Square } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { AppLink } from "../../components/AppLink";
import { href } from "../../routes";
import { AnswerBox } from "../clarify/AnswerBox";
import { TranscriptTail } from "../transcript/TranscriptTail";
import { RunMoves } from "./RunMoves";
import {
	type RunControlTarget,
	StopRunDialog,
	useRunControls,
} from "./useRunControls";

/**
 * The agent, wherever the work is shown: a live tail with approvals
 * answerable in place, the open question (if the run asked one), steer, stop
 * and the way into the full transcript. The dock rows and the task page's run
 * panel render this; the run page uses the same `useRunControls` around its
 * full transcript.
 *
 * Mounting it opens one `live.runOutput` stream (through `TranscriptTail`),
 * so callers render it only for the row that is expanded.
 */
export function RunConsole({
	target,
	lines = 30,
	heightClass = "h-48",
}: {
	target: RunControlTarget;
	lines?: number;
	heightClass?: string;
}) {
	const controls = useRunControls(target);
	const [steerText, setSteerText] = useState("");

	return (
		<div className="flex min-w-0 flex-col gap-2">
			{/* Shared clarify.open cache (invalidated by the live channel): no extra request. */}
			<AnswerBox project={target.project} runId={target.runId} />

			<TranscriptTail
				project={target.project}
				runId={target.runId}
				runState={target.state}
				lines={lines}
				heightClass={heightClass}
				approval={controls.approvals ? controls.approval : undefined}
			/>

			{controls.steerable ? (
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						controls.steer.send(steerText, { onSent: () => setSteerText("") });
					}}
				>
					<Input
						value={steerText}
						placeholder="Steer the agent…"
						onChange={(e) => setSteerText(e.target.value)}
						aria-label={`Steer ${target.label}`}
					/>
					<Button
						type="submit"
						size="sm"
						variant="outline"
						disabled={controls.steer.pending || steerText.trim().length === 0}
					>
						<Send aria-hidden />
						{controls.steer.pending ? "Sending…" : "Send"}
					</Button>
				</form>
			) : null}

			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="ghost" asChild>
					<AppLink to={href.run(target.project, target.runId)}>
						<ScrollText aria-hidden /> Open transcript
					</AppLink>
				</Button>
				<span className="flex-1" />
				<RunMoves target={target} controls={controls} />
				{controls.stoppable || controls.stop.pending ? (
					<Button
						size="sm"
						variant="destructive"
						disabled={controls.stop.pending}
						onClick={controls.stop.request}
					>
						<Square aria-hidden />
						{controls.stop.pending ? "Stopping…" : "Stop"}
					</Button>
				) : null}
			</div>

			<StopRunDialog controls={controls} target={target} />
		</div>
	);
}
