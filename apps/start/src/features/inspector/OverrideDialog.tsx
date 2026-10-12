import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { humanizeToken } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { type RouterOutputs, useTRPC } from "../../lib/trpc";

/**
 * Override one brain decision (U6-01). The brain has the final say; a person
 * steps in only by choice, and the dialog says exactly what will happen
 * before anything does: the inverse operation, step by step, from
 * `brain.overridePreview`. A reason is required: it is audited, it names the
 * override in the task Story and the brain's feed, and the brain reads it on
 * its next wake.
 */

export type OverridePreview = RouterOutputs["brain"]["overridePreview"];

/** Whether the confirm button may be pressed. Pure, so the rule is tested. */
export function overrideBlocked(
	preview: Pick<OverridePreview, "state"> | undefined,
	reason: string,
): string | null {
	if (!preview) return "Working out what overriding would do…";
	if (preview.state === "overridden") return "Already overridden.";
	if (preview.state === "not_applicable") return "Nothing here can be undone.";
	if (reason.trim().length === 0) return "A reason is required.";
	return null;
}

/** The body: the inverse operation and the reason field. No data of its own. */
export function OverrideBody({
	preview,
	reason,
	onReason,
	error,
}: {
	preview: OverridePreview | undefined;
	reason: string;
	onReason: (next: string) => void;
	error?: string | null;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-3" data-testid="override-body">
			<div
				className="flex flex-col gap-1 border p-2"
				style={{
					borderColor: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					Overriding{" "}
					{preview?.tool ? humanizeToken(preview.tool) : "this decision"} will:
				</span>
				{!preview ? (
					<span>Working out the inverse…</span>
				) : preview.state === "ready" ? (
					<ol className="m-0 list-decimal pl-4" data-testid="override-steps">
						{preview.steps.map((s) => (
							<li key={`${s.op}:${s.summary}`}>{s.summary}</li>
						))}
					</ol>
				) : (
					<span data-testid="override-note">{preview.summary}</span>
				)}
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={id}>Why (required; the brain reads it)</Label>
				<Textarea
					id={id}
					value={reason}
					rows={3}
					maxLength={2000}
					placeholder="What the brain missed, or what you want instead"
					onChange={(e) => onReason(e.target.value)}
				/>
			</div>
			{error ? (
				<p className="m-0" style={{ color: "var(--mfw-critical)" }}>
					{error}
				</p>
			) : null}
		</div>
	);
}

export function OverrideDialog({
	project,
	decisionId,
	open,
	onOpenChange,
}: {
	project: string;
	decisionId: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [reason, setReason] = useState("");
	const preview = useQuery({
		...trpc.brain.overridePreview.queryOptions({ project, decisionId }),
		enabled: open,
	});
	useEffect(() => {
		if (!open) setReason("");
	}, [open]);

	const override = useMutation(
		trpc.brain.override.mutationOptions({
			meta: { label: "Override decision" },
			onSuccess: () => {
				onOpenChange(false);
				toast({
					tone: "success",
					title: "Decision overridden",
					description: "The brain is told and will see your reason.",
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.brain.decisions.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.brain.session.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.node.story.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
			},
		}),
	);

	const blocked = overrideBlocked(preview.data, reason);
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Override this decision"
			confirmLabel={
				preview.data?.state === "acknowledge" ? "Record override" : "Override"
			}
			pending={override.isPending}
			confirmDisabled={blocked !== null}
			description="The inverse operation runs now. The override is audited and the brain wakes to hear about it."
			onConfirm={() =>
				override.mutate({ project, decisionId, reason: reason.trim() })
			}
		>
			<OverrideBody
				preview={preview.data}
				reason={reason}
				onReason={setReason}
				error={
					override.error?.message ??
					(preview.isError ? preview.error.message : null)
				}
			/>
		</ConfirmDialog>
	);
}
