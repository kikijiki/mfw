import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Panel } from "../../components/Page";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";

/**
 * Delete every task on the board.
 *
 * `"wipe the board"` is the server's confirmation token (a `z.literal` on the
 * wire), typed into `ConfirmDialog` and passed through unchanged.
 *
 * Recovery claims come only from the daemon: `tasks.wipe` returns `versioned`
 * and a `recovery` sentence, rendered verbatim (git-tracked boards can be
 * reverted; others cannot). Lives in project settings, not on the board, and
 * fetches its own task list since the board may not be mounted.
 */

type Wipe = RouterOutputs["tasks"]["wipe"];

export function WipeBoard({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [open, setOpen] = useState(false);

	const tasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	const taskIds = tasks.data?.map((t) => t.id) ?? [];

	const wipe = useMutation(
		trpc.tasks.wipe.mutationOptions({
			meta: { label: "Wipe board" },
			onSuccess: (result: Wipe) => {
				setOpen(false);
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.tasks.graph.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());

				if (result.deleted === 0) {
					// Nothing deleted, so no recovery notice.
					toast({
						tone: "info",
						title: `${project}'s board was already empty`,
					});
					return;
				}
				toast({
					tone: result.versioned ? "success" : "warning",
					title: `Deleted ${result.deleted} task${result.deleted === 1 ? "" : "s"} from ${project}`,
					description: result.recovery,
					// Never auto-dismissed: it holds the undo command, or the notice that there is none.
					duration: 0,
				});
			},
		}),
	);

	return (
		<Panel title="Danger zone">
			<div className="flex flex-wrap items-center gap-3">
				<p
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					Deletes every task on <span className="mfw-num">{project}</span>'s
					board, in every column.
				</p>
				<span className="flex-1" />
				<Button
					size="sm"
					variant="destructive"
					disabled={tasks.isLoading || taskIds.length === 0}
					onClick={() => setOpen(true)}
				>
					Wipe board
				</Button>
			</div>

			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title={`Wipe ${project}'s board`}
				confirmText="wipe the board"
				confirmLabel={`Delete ${taskIds.length} task${taskIds.length === 1 ? "" : "s"}`}
				pending={wipe.isPending}
				description={
					<>
						Deletes every task folder (including specs and attachments) in{" "}
						<span className="mfw-num">{project}</span>, in every column:
						including tasks a run is holding right now. Deleting them does not
						stop those runs, and run history and code are untouched.
					</>
				}
				onConfirm={() => wipe.mutate({ project, confirm: "wipe the board" })}
			>
				<div
					className="mfw-num max-h-32 overflow-y-auto border p-2"
					style={{
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-sm)",
						background: "var(--mfw-bg-inset)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{taskIds.join("  ")}
				</div>
			</ConfirmDialog>
		</Panel>
	);
}
