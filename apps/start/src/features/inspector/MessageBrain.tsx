import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Send } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import { letBrainDecideText } from "../brain/steering";

/**
 * Write to the brain (U6-02): a durable note that wakes it. `about` is a node
 * ref (`task:<id>`, `run:<id>`, `decision:<n>`) when the note concerns one
 * thing; the brain's next digest carries the text whole. The brain decides
 * what to do with it: this is advice, not a command.
 */

/** The mutation and its cache effects, shared by the box and the needs-queue button. */
export function useMessageBrain(project: string) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	return useMutation(
		trpc.brain.message.mutationOptions({
			meta: { label: "Message the brain" },
			onSuccess: () =>
				toast({
					tone: "success",
					title: "Sent to the brain",
					description: "It wakes now and will see your note in its digest.",
				}),
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.brain.decisions.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.brain.turns.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.node.story.queryFilter({ project }),
				);
			},
		}),
	);
}

export function MessageBrain({
	project,
	about,
	placeholder = "Tell the brain something it should weigh…",
	onSent,
}: {
	project: string;
	/** `task:<id>` and friends; omitted for a note about the project as a whole. */
	about?: string;
	placeholder?: string;
	onSent?: () => void;
}) {
	const id = useId();
	const [text, setText] = useState("");
	const send = useMessageBrain(project);
	const empty = text.trim().length === 0;

	return (
		<form
			data-testid="message-brain"
			className="flex flex-col gap-1.5 border-b px-3 py-2"
			style={{ borderColor: "var(--mfw-border)" }}
			onSubmit={(e) => {
				e.preventDefault();
				if (empty || send.isPending) return;
				send.mutate(
					{ project, text: text.trim(), ...(about ? { about } : {}) },
					{
						onSuccess: () => {
							setText("");
							onSent?.();
						},
					},
				);
			}}
		>
			<Label
				htmlFor={id}
				className="flex items-center gap-1.5"
				style={{ fontSize: "var(--mfw-text-xs)" }}
			>
				<MessageSquare aria-hidden className="size-3.5" />
				Message the brain{about ? ` about ${about}` : ""}
			</Label>
			<Textarea
				id={id}
				value={text}
				rows={2}
				maxLength={4000}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<div className="flex items-center gap-2">
				<Button
					type="submit"
					size="xs"
					variant="outline"
					disabled={empty || send.isPending}
				>
					<Send aria-hidden /> {send.isPending ? "Sending…" : "Send"}
				</Button>
				{send.error ? (
					<span
						style={{
							color: "var(--mfw-critical)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{send.error.message}
					</span>
				) : null}
			</div>
		</form>
	);
}

/** The needs-queue button for a `notify_human` item: hand the choice back (the brain decides, and the item leaves the queue). */
export function LetBrainDecide({
	project,
	title,
	taskId,
	onDone,
}: {
	project: string;
	title: string;
	taskId?: string;
	onDone?: () => void;
}) {
	const send = useMessageBrain(project);
	return (
		<Button
			size="sm"
			variant="outline"
			disabled={send.isPending}
			onClick={() =>
				send.mutate(
					{
						project,
						text: letBrainDecideText(title),
						...(taskId ? { about: `task:${taskId}` } : {}),
					},
					{ onSuccess: () => onDone?.() },
				)
			}
		>
			{send.isPending ? "Sending…" : "Let the brain decide"}
		</Button>
	);
}
