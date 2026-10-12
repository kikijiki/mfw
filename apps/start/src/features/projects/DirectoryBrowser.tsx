import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronRight, Folder, FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";

import { Mono } from "~/components/Cost";
import { ErrorState } from "~/components/ErrorState";
import { LoadingRows } from "~/components/Loading";
import { Button } from "~/components/ui/button";
import type { RouterOutputs } from "~/lib/trpc";
import { useTRPC } from "~/lib/trpc";

export type Directory = RouterOutputs["system"]["projectDirectory"];
export type DirectoryEntry = Directory["directories"][number];

/**
 * The daemon-side folder browser. In "repo" mode only repositories can be
 * selected (other folders open); in "folder" mode every folder just opens, and
 * the caller's `footer` decides what "use this folder" means.
 */
export function DirectoryBrowser({
	path,
	onPathChange,
	mode,
	selectedPath,
	onSelectRepo,
	footer,
}: {
	path: string | undefined;
	onPathChange: (path: string | undefined) => void;
	mode: "repo" | "folder";
	selectedPath?: string | null;
	onSelectRepo?: (entry: DirectoryEntry) => void;
	footer?: (directory: Directory | undefined) => ReactNode;
}) {
	const trpc = useTRPC();
	const directory = useQuery({
		...trpc.system.projectDirectory.queryOptions({ path }),
		staleTime: 10_000,
	});

	const choose = (entry: DirectoryEntry) => {
		if (mode === "repo" && entry.isRepository) {
			onSelectRepo?.(entry);
			return;
		}
		onPathChange(entry.path);
	};

	return (
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
					onClick={() => onPathChange(directory.data?.parent ?? undefined)}
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
						{[...(directory.data?.directories ?? [])]
							// Dot-folders last: in a home directory they bury the real projects.
							.sort(
								(a, b) =>
									Number(a.name.startsWith(".")) -
									Number(b.name.startsWith(".")),
							)
							.map((entry) => {
								const active = selectedPath === entry.path;
								const isRepoPick = mode === "repo" && entry.isRepository;
								return (
									<li key={entry.path}>
										<button
											type="button"
											disabled={isRepoPick && entry.attached}
											aria-pressed={isRepoPick ? active : undefined}
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
											{isRepoPick && entry.attached ? (
												<span style={{ fontSize: "var(--mfw-text-2xs)" }}>
													Attached
												</span>
											) : active ? (
												<Check />
											) : isRepoPick ? (
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

			{footer?.(directory.data)}
		</div>
	);
}
