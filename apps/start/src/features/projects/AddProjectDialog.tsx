import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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
import { useTRPC } from "~/lib/trpc";

import {
	type AddState,
	boardFolderOf,
	buildAddInput,
	describeInspection,
	effectiveInspection,
	needsInspection,
	summarize,
} from "./addProject";
import { BoardStep } from "./BoardStep";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { FolderPicker, rememberBoardFolder } from "./FolderPicker";

/** repo: choose the repository. board: where the board lives and what happens. folder: pick the board's folder. */
type Step = "repo" | "board" | "folder";

const EMPTY: AddState = { repo: null, board: { kind: "repo" }, template: null };

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
	const [step, setStep] = useState<Step>("repo");
	const [state, setState] = useState<AddState>(EMPTY);
	const [browsePath, setBrowsePath] = useState<string | undefined>();

	useEffect(() => {
		if (!open) {
			setStep("repo");
			setState(EMPTY);
			setBrowsePath(undefined);
		}
	}, [open]);

	const boardFolder = boardFolderOf(state);
	const queried = needsInspection(state);
	const inspection = useQuery({
		...trpc.system.inspectBoardFolder.queryOptions({
			path: boardFolder ?? "",
		}),
		enabled: open && step === "board" && queried && boardFolder !== null,
		staleTime: 0,
		retry: false,
	});
	const templates = useQuery({
		...trpc.system.boardTemplates.queryOptions(),
		enabled: open && step === "board",
		staleTime: 60_000,
	});

	const effective = effectiveInspection(
		state,
		queried ? inspection.data : undefined,
	);
	const view = describeInspection(inspection.error ? null : effective);
	const templateList = templates.data ?? [];
	const input = buildAddInput(state, effective, templateList);

	const add = useMutation(
		trpc.system.addProject.mutationOptions({
			meta: { label: "Add project" },
			onSuccess: (added) => {
				if (state.board.kind === "folder")
					rememberBoardFolder(state.board.path);
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

	const change = (next: AddState) => {
		add.reset();
		setState(next);
	};

	const description =
		step === "folder"
			? "Choose the folder that will hold this project's board: board.yaml, tasks and ADRs. Worktrees, runs and the database stay with the repository."
			: step === "board"
				? "Decide where the board lives. Nothing is created until you press Add."
				: "Choose a Git repository visible to the MFW daemon.";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="mfw-v2 flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{step === "repo"
							? "Add a project · 1 of 2: repository"
							: "Add a project · 2 of 2: board"}
					</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div data-step={step} className="min-h-0 flex-1 overflow-y-auto">
					{step === "repo" ? (
						<div className="flex flex-col gap-2">
							<DirectoryBrowser
								mode="repo"
								path={browsePath}
								onPathChange={setBrowsePath}
								selectedPath={state.repo}
								onSelectRepo={(entry) => change({ ...EMPTY, repo: entry.path })}
							/>
							<p
								className="min-h-10 px-1"
								style={{
									color: "var(--mfw-fg-muted)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								{state.repo ? (
									<>
										Repository: <span className="mfw-num">{state.repo}</span>
									</>
								) : (
									"Open folders to find a repository, then select it."
								)}
							</p>
						</div>
					) : step === "folder" && state.repo ? (
						<FolderPicker
							repo={state.repo}
							onUse={(path, create) => {
								change({
									...state,
									board:
										path === state.repo
											? { kind: "repo" }
											: { kind: "folder", path, create },
								});
								setStep("board");
							}}
						/>
					) : (
						<BoardStep
							state={state}
							onChange={change}
							folderPath={
								state.board.kind === "folder" ? state.board.path : null
							}
							onPickFolder={() => setStep("folder")}
							inspection={queried ? inspection : null}
							view={view}
							templates={templates}
							summary={summarize(state, effective, templateList)}
							error={add.error ? add.error.message : null}
						/>
					)}
				</div>

				<DialogFooter>
					<Button
						variant="ghost"
						className="max-md:min-h-11"
						disabled={add.isPending}
						onClick={() => {
							if (step === "folder") setStep("board");
							else if (step === "board") setStep("repo");
							else onOpenChange(false);
						}}
					>
						{step === "repo" ? "Cancel" : "Back"}
					</Button>
					{step === "repo" ? (
						<Button
							className="max-md:min-h-11"
							disabled={!state.repo}
							onClick={() => setStep("board")}
						>
							Next: board
						</Button>
					) : step === "board" ? (
						<Button
							className="max-md:min-h-11"
							disabled={add.isPending || !input}
							onClick={() => {
								if (input) add.mutate(input);
							}}
						>
							{add.isPending ? "Attaching…" : "Add project"}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
