import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronRight, Folder, FolderGit2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Mono } from "~/components/Cost";
import { ErrorState } from "~/components/ErrorState";
import { LoadingRows } from "~/components/Loading";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { useToast } from "~/lib/toast";
import type { RouterOutputs } from "~/lib/trpc";
import { useTRPC } from "~/lib/trpc";

type Directory = RouterOutputs["system"]["projectDirectory"];
type DirectoryEntry = Directory["directories"][number];

export function AddProjectDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [path, setPath] = useState<string | undefined>();
	const [selected, setSelected] = useState<DirectoryEntry | null>(null);

	useEffect(() => {
		if (!open) {
			setPath(undefined);
			setSelected(null);
		}
	}, [open]);

	const directory = useQuery({
		...trpc.system.projectDirectory.queryOptions({ path }),
		enabled: open,
		staleTime: 10_000,
	});

	const add = useMutation(
		trpc.system.addProject.mutationOptions({
			meta: { label: "Add project" },
			onSuccess: (added) => {
				onOpenChange(false);
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
					title: `${added.name} attached`,
					description: `Merges will land on ${added.integrationBranch}.`,
				});
			},
		}),
	);

	const choose = (entry: DirectoryEntry) => {
		if (entry.isRepository) {
			setSelected(entry);
			return;
		}
		setSelected(null);
		setPath(entry.path);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="mfw-v2 sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Add a project</DialogTitle>
					<DialogDescription>
						Choose a Git repository visible to the MFW daemon.
					</DialogDescription>
				</DialogHeader>

				<div className="flex min-h-72 flex-col gap-2">
					<div
						className="flex min-h-8 items-center gap-2 border px-2"
						style={{
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
						}}
					>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="max-md:size-11"
							aria-label="Parent directory"
							disabled={!directory.data?.parent || directory.isFetching}
							onClick={() => {
								setSelected(null);
								setPath(directory.data?.parent ?? undefined);
							}}
						>
							<ArrowUp />
						</Button>
						<div className="min-w-0 flex-1 overflow-hidden">
							<Mono value={directory.data?.path ?? "Loading…"} />
						</div>
					</div>

					<div
						className="min-h-0 flex-1 overflow-y-auto border p-1"
						style={{
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
						}}
					>
						{directory.isLoading ? (
							<LoadingRows rows={6} />
						) : directory.error ? (
							<ErrorState
								title="Could not open this directory"
								error={directory.error}
								onRetry={() => void directory.refetch()}
							/>
						) : directory.data?.directories.length === 0 ? (
							<p
								className="p-3 text-center"
								style={{
									color: "var(--mfw-fg-faint)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								No subdirectories here.
							</p>
						) : (
							<ul className="flex flex-col gap-0.5">
								{directory.data?.directories.map((entry) => {
									const active = selected?.path === entry.path;
									return (
										<li key={entry.path}>
											<button
												type="button"
												disabled={entry.attached}
												aria-pressed={entry.isRepository ? active : undefined}
												className="mfw-focus flex min-h-11 w-full items-center gap-2 px-2 text-left disabled:opacity-50 md:min-h-9"
												style={{
													borderRadius: "var(--mfw-radius-sm)",
													background: active
														? "var(--mfw-accent-subtle)"
														: "transparent",
													color: active ? "var(--mfw-accent)" : "var(--mfw-fg)",
												}}
												onClick={() => choose(entry)}
											>
												{entry.isRepository ? <FolderGit2 /> : <Folder />}
												<span className="min-w-0 flex-1 truncate">
													{entry.name}
												</span>
												{entry.attached ? (
													<span style={{ fontSize: "var(--mfw-text-2xs)" }}>
														Attached
													</span>
												) : active ? (
													<Check />
												) : entry.isRepository ? (
													<span style={{ fontSize: "var(--mfw-text-2xs)" }}>
														Select
													</span>
												) : (
													<ChevronRight />
												)}
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>

					<div
						className="min-h-10 px-1"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{selected ? (
							<>
								Project <strong>{selected.name}</strong> will use the repository
								at <span className="mfw-num">{selected.path}</span>.
							</>
						) : (
							"Open folders to find a repository, then select it."
						)}
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="ghost"
						className="max-md:min-h-11"
						disabled={add.isPending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						className="max-md:min-h-11"
						disabled={add.isPending || !selected}
						onClick={() => {
							if (!selected) return;
							add.mutate({ root: selected.path });
						}}
					>
						{add.isPending ? "Attaching…" : "Add project"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
