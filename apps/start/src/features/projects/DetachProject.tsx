import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ConfirmDialog } from "~/components/ConfirmDialog";
import { Panel } from "~/components/Page";
import { Button } from "~/components/ui/button";
import { useGo } from "~/lib/nav";
import { useToast } from "~/lib/toast";
import { useTRPC } from "~/lib/trpc";
import { href } from "~/routes";

/** Detaching belongs to the selected project's own settings, not global Settings. */
export function DetachProject({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const go = useGo();
	const { toast } = useToast();
	const [open, setOpen] = useState(false);

	const remove = useMutation(
		trpc.system.removeProject.mutationOptions({
			meta: { label: "Remove project" },
			onSuccess: (result) => {
				setOpen(false);
				void queryClient.invalidateQueries(trpc.system.projects.queryFilter());
				void queryClient.invalidateQueries(
					trpc.system.scheduler.all.queryFilter(),
				);
				void queryClient.invalidateQueries(
					trpc.system.scheduler.status.queryFilter(),
				);
				void queryClient.invalidateQueries(trpc.system.health.queryFilter());
				void queryClient.invalidateQueries(trpc.inbox.list.queryFilter());
				toast({
					tone: "success",
					title: `${result.name} detached`,
					description: `MFW data in ${result.root} was kept. Adding it again restores the project.`,
					duration: 0,
				});
				go(href.now(), { replace: true });
			},
		}),
	);

	return (
		<Panel title="Project attachment">
			<div className="flex flex-wrap items-center gap-3">
				<p
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					Removing this project only detaches it. Its data stays in the
					repository.
				</p>
				<span className="flex-1" />
				<Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
					Remove project
				</Button>
			</div>

			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title={`Remove ${project} from MFW`}
				confirmText={project}
				confirmLabel="Remove"
				pending={remove.isPending}
				description={
					<>
						MFW will stop working on this project.{" "}
						<strong>Your code and MFW data are kept.</strong> MFW may commit
						pending board changes before it lets go.
					</>
				}
				onConfirm={() => remove.mutate({ name: project })}
			/>
		</Panel>
	);
}
