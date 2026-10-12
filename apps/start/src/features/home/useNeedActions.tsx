import type { InboxItem } from "@mfw/daemon/inbox";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";

/**
 * The mutations a needs-you row can make that are not about a run: dismiss
 * an item, and retry/abandon/send-to-ready a parked merge. Moved here from
 * the Inbox page so Home and the presence popover share one path; every
 * action invalidates `inbox.list`, so the badge and the list move together.
 */
export interface NeedActions {
	dismiss: (item: InboxItem) => void;
	retryMerge: (item: InboxItem) => void;
	/** Opens the confirmation; the discarding actions never fire on one click. */
	requestMerge: (item: InboxItem, action: "abandon" | "sendToReady") => void;
	/** Render once, anywhere under the provider tree. */
	dialog: ReactNode;
}

export function useNeedActions(): NeedActions {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [confirming, setConfirming] = useState<{
		item: InboxItem;
		action: "abandon" | "sendToReady";
	} | null>(null);

	const refresh = () =>
		void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());

	const dismiss = useMutation(
		trpc.inbox.dismiss.mutationOptions({
			meta: { label: "Dismiss" },
			onMutate: async (vars) => {
				const filter = trpc.inbox.list.queryFilter();
				await queryClient.cancelQueries(filter);
				const previous = queryClient.getQueryData(trpc.inbox.list.queryKey());
				queryClient.setQueryData(trpc.inbox.list.queryKey(), (data) => {
					if (!data) return data;
					const gone = data.items.find((i) => i.id === vars.itemId);
					if (!gone) return data;
					return {
						items: data.items.filter((i) => i.id !== vars.itemId),
						counts: {
							total: data.counts.total - 1,
							critical:
								data.counts.critical - (gone.severity === "critical" ? 1 : 0),
							attention:
								data.counts.attention - (gone.severity === "attention" ? 1 : 0),
						},
					};
				});
				return { previous };
			},
			onError: (_err, _vars, ctx) => {
				if (ctx?.previous)
					queryClient.setQueryData(trpc.inbox.list.queryKey(), ctx.previous);
			},
			onSettled: refresh,
		}),
	);

	const retry = useMutation(
		trpc.review.mergeJob.retry.mutationOptions({
			meta: { label: "Retry merge" },
			onSuccess: () =>
				toast({
					tone: "success",
					title: "Retrying the merge",
					description: "Back in the queue. A repeat conflict parks it again.",
				}),
			onSettled: refresh,
		}),
	);

	const abandon = useMutation(
		trpc.review.mergeJob.abandon.mutationOptions({
			meta: { label: "Abandon merge" },
			onSuccess: () => {
				setConfirming(null);
				toast({
					tone: "success",
					title: "Merge job abandoned",
					description:
						"The branch will not merge. The task's own status is unchanged.",
				});
			},
			onSettled: refresh,
		}),
	);

	const sendToReady = useMutation(
		trpc.review.mergeJob.sendToReady.mutationOptions({
			meta: { label: "Send to ready" },
			onSuccess: () => {
				setConfirming(null);
				toast({
					tone: "success",
					title: "Sent back to ready",
					description:
						"The branch is abandoned; the task will be re-dispatched from the current tip.",
				});
			},
			onSettled: refresh,
		}),
	);

	const isAbandon = confirming?.action === "abandon";
	const dialog = (
		<ConfirmDialog
			open={confirming !== null}
			onOpenChange={(next) => {
				if (!next) setConfirming(null);
			}}
			pending={isAbandon ? abandon.isPending : sendToReady.isPending}
			title={isAbandon ? "Abandon this merge" : "Send back to ready"}
			confirmLabel={isAbandon ? "Abandon" : "Send to ready"}
			description={
				isAbandon
					? "The branch will not merge and this job will not retry. The task's own status is left exactly where it is. This only ends the job."
					: "The branch is discarded and the task goes back to ready, to be re-done from the current tip. The work already on the branch is not recovered from here."
			}
			onConfirm={() => {
				const jobId = confirming?.item.mergeJobId;
				if (!confirming || jobId === undefined) return;
				const vars = { project: confirming.item.project, jobId };
				if (isAbandon) abandon.mutate(vars);
				else sendToReady.mutate(vars);
			}}
		/>
	);

	return {
		dismiss: (item) =>
			dismiss.mutate({ project: item.project, itemId: item.id }),
		retryMerge: (item) => {
			if (item.mergeJobId === undefined) return;
			retry.mutate({ project: item.project, jobId: item.mergeJobId });
		},
		requestMerge: (item, action) => {
			if (item.mergeJobId === undefined) return;
			setConfirming({ item, action });
		},
		dialog,
	};
}
