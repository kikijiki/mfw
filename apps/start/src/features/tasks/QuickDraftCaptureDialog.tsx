import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { humanizeError } from "~/lib/toast";
import type { RouterOutputs } from "~/lib/trpc";
import { useTRPC } from "~/lib/trpc";

type CapturedDraft = RouterOutputs["tasks"]["captureQuick"];

export interface QuickDraftCaptureDialogProps {
	project: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Editable text placed at the start of the prompt each time the dialog opens. */
	initialPromptPrefix?: string;
	onSuccess: (draft: CapturedDraft) => void;
}

export function quickDraftCanSubmit(
	prompt: string,
	initialPromptPrefix = "",
): boolean {
	const text = prompt.trim();
	return text.length > 0 && text !== initialPromptPrefix.trim();
}

export function quickDraftCaptureVariables(
	project: string,
	prompt: string,
	requestId: string,
	afterExpansion: "backlog" | "ready",
	requireReview: boolean,
) {
	return {
		project,
		text: prompt.trim(),
		requestId,
		afterExpansion,
		requireReview,
	};
}

/** A controlled one-line capture surface for tasks that agents expand later. */
export function QuickDraftCaptureDialog({
	project,
	open,
	onOpenChange,
	initialPromptPrefix = "",
	onSuccess,
}: QuickDraftCaptureDialogProps) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const promptId = useId();
	const reviewId = useId();
	const [prompt, setPrompt] = useState(initialPromptPrefix);
	const [afterExpansion, setAfterExpansion] = useState<"backlog" | "ready">(
		"ready",
	);
	const [requireReview, setRequireReview] = useState(false);
	const requestId = useRef(globalThis.crypto.randomUUID());
	const wasOpen = useRef(open);
	const latestPrefix = useRef(initialPromptPrefix);
	latestPrefix.current = initialPromptPrefix;

	const capture = useMutation(
		trpc.tasks.captureQuick.mutationOptions({
			meta: { label: "Capture task", toast: false },
			retry: 2,
			onSuccess: (draft) => {
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.graph.queryFilter({ project }),
				);
				requestId.current = globalThis.crypto.randomUUID();
				onSuccess(draft);
				onOpenChange(false);
			},
		}),
	);

	// The dialog stays mounted above Radix's portal. Re-seed every opening so
	// closing never saves partial edits or an error from the previous attempt.
	useEffect(() => {
		if (open && !wasOpen.current) {
			setPrompt(latestPrefix.current);
			setAfterExpansion("ready");
			setRequireReview(false);
			capture.reset();
		}
		wasOpen.current = open;
	}, [open, capture.reset]);

	const pending = capture.isPending;
	const canSubmit = quickDraftCanSubmit(prompt, initialPromptPrefix);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending || !quickDraftCanSubmit(prompt, latestPrefix.current)) return;
		capture.mutate(
			quickDraftCaptureVariables(
				project,
				prompt,
				requestId.current,
				afterExpansion,
				requireReview,
			),
		);
	};

	const changeOpen = (nextOpen: boolean) => {
		// Once submitted, closing is no longer cancellation. Keep the pending
		// state visible until the request resolves and suppress duplicate actions.
		if (!nextOpen && pending) return;
		onOpenChange(nextOpen);
	};

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent className="mfw-v2 sm:max-w-lg">
				<form className="contents" onSubmit={submit} aria-busy={pending}>
					<DialogHeader>
						<DialogTitle>Capture task</DialogTitle>
						<DialogDescription>
							Describe what needs doing in one line. An agent will expand it
							into a complete task draft.
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2">
						<Label htmlFor={promptId}>Prompt</Label>
						<Input
							id={promptId}
							autoFocus
							value={prompt}
							disabled={pending}
							placeholder="What needs doing?"
							onFocus={(event) => {
								const end = event.currentTarget.value.length;
								event.currentTarget.setSelectionRange(end, end);
							}}
							onChange={(event) => setPrompt(event.target.value)}
						/>
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-2">
							<Label htmlFor={`${promptId}-destination`}>After expansion</Label>
							<Select
								value={afterExpansion}
								onValueChange={(value) =>
									setAfterExpansion(value as "backlog" | "ready")
								}
							>
								<SelectTrigger id={`${promptId}-destination`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper">
									<SelectItem value="ready">Move to ready</SelectItem>
									<SelectItem value="backlog">Keep in backlog</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<Label
							htmlFor={reviewId}
							className="flex min-h-9 items-center gap-2 self-end"
						>
							<Checkbox
								id={reviewId}
								checked={requireReview}
								onCheckedChange={(checked) =>
									setRequireReview(checked === true)
								}
							/>
							Require human review
						</Label>
					</div>

					{capture.error ? (
						<p role="alert" className="text-sm text-destructive">
							Could not capture task: {humanizeError(capture.error)}
						</p>
					) : null}

					<DialogFooter>
						<Button type="submit" disabled={pending || !canSubmit}>
							{pending ? "Capturing…" : "Capture task"}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => changeOpen(false)}
						>
							Cancel
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
