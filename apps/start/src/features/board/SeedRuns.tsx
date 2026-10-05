import { useMutation, useQuery } from "@tanstack/react-query";
import { GitBranch, ScanSearch } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { Setting } from "../settings/controls";
import { ModelPicker } from "../settings/ProviderPicker";

/** One-off agent runs that turn a repository survey or a goal into board work. */

export function SeedRunActions({ project }: { project: string }) {
	const [open, setOpen] = useState<"import" | "plan" | null>(null);

	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen("import")}>
				<ScanSearch aria-hidden /> Import from repo
			</Button>
			<Button size="sm" variant="outline" onClick={() => setOpen("plan")}>
				<GitBranch aria-hidden /> Plan a goal
			</Button>

			<ImportDialog
				project={project}
				open={open === "import"}
				onOpenChange={(v) => setOpen(v ? "import" : null)}
			/>
			<PlanDialog
				project={project}
				open={open === "plan"}
				onOpenChange={(v) => setOpen(v ? "plan" : null)}
			/>
		</>
	);
}

/** The run model, seeded from the project setting so the operator sees what will be used (the server would otherwise fall back invisibly). */
function useRunModel(project: string) {
	const trpc = useTRPC();
	const settings = useQuery(trpc.settings.get.queryOptions({ project }));
	const configured = settings.data?.values.model ?? "";
	const [model, setModel] = useState("");

	// Adopt the project's model once; a refetch must not refill a field the operator cleared.
	useEffect(() => {
		if (configured !== "") setModel((current) => current || configured);
	}, [configured]);

	return {
		model,
		setModel,
		providerId: settings.data?.values.provider.id ?? "",
		/** Absent means the project's configured model; sent only when it differs. */
		override:
			model.trim() !== "" && model.trim() !== configured
				? model.trim()
				: undefined,
	};
}

function ImportDialog({
	project,
	open,
	onOpenChange,
}: {
	project: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const start = useStartImport(project, "Import", onOpenChange);
	const run = useRunModel(project);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import work from this repository</DialogTitle>
					<DialogDescription>
						An agent reviews {project} and proposes tasks. It does not change
						code.
					</DialogDescription>
				</DialogHeader>

				<Consequences>
					<li>Proposed tasks are added in the status the agent observed.</li>
					<li>Long-lived requirements can be saved as a task's spec.</li>
					<li>
						Outstanding tasks are asked for explicit acceptance criteria.
						Project merge checks apply to every candidate; focused task checks
						are optional.
					</li>
					<li>
						Running it again reuses tasks whose titles match exactly. Different
						wording can still create a duplicate.
					</li>
				</Consequences>

				<ModelRow
					providerId={run.providerId}
					model={run.model}
					setModel={run.setModel}
				/>

				<DialogFooter>
					<Button
						variant="ghost"
						disabled={start.isPending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={start.isPending}
						onClick={() => start.mutate({ project, model: run.override })}
					>
						{start.isPending ? "Starting…" : "Start import"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PlanDialog({
	project,
	open,
	onOpenChange,
}: {
	project: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const trpc = useTRPC();
	const { toast } = useToast();
	const go = useGo();
	const run = useRunModel(project);
	const [goal, setGoal] = useState("");
	const goalId = useId();

	const start = useMutation(
		trpc.runs.startPlan.mutationOptions({
			meta: { label: "Plan" },
			onSuccess: (started) => {
				onOpenChange(false);
				setGoal("");
				toast({ tone: "success", title: "Plan run started" });
				go(href.run(project, started.runId));
			},
		}),
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Plan a goal into tasks</DialogTitle>
					<DialogDescription>
						An agent decomposes one goal into a dependency-ordered set of tasks,
						with specs where useful, on {project}'s board.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-1">
					<label
						htmlFor={goalId}
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						goal
					</label>
					<Textarea
						id={goalId}
						rows={4}
						autoFocus
						placeholder="Ship a read-only public API for the task board, authenticated by API key."
						value={goal}
						onChange={(e) => setGoal(e.target.value)}
					/>
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						Include important constraints and non-goals.
					</span>
				</div>

				<Consequences>
					<li>
						Tasks are created in <strong>backlog</strong>, with the dependencies
						the planner declared between them.
					</li>
					<li>It may write specs for tasks. It does not change code.</li>
					<li>
						Every task is asked for explicit acceptance criteria. It becomes
						ready once its dependencies are done; verification gates the later
						merge.
					</li>
				</Consequences>

				<ModelRow
					providerId={run.providerId}
					model={run.model}
					setModel={run.setModel}
				/>

				<DialogFooter>
					<Button
						variant="ghost"
						disabled={start.isPending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={start.isPending || goal.trim() === ""}
						onClick={() =>
							start.mutate({
								project,
								goal: goal.trim(),
								model: run.override,
							})
						}
					>
						{start.isPending ? "Starting…" : "Start planning"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Import takes only the model, so the mutation is the whole hook. */
function useStartImport(
	project: string,
	label: string,
	onOpenChange: (open: boolean) => void,
) {
	const trpc = useTRPC();
	const { toast } = useToast();
	const go = useGo();

	return useMutation(
		trpc.runs.startImport.mutationOptions({
			meta: { label },
			onSuccess: (started) => {
				onOpenChange(false);
				toast({ tone: "success", title: `${label} run started` });
				// The run takes minutes; its transcript is the progress display.
				go(href.run(project, started.runId));
			},
		}),
	);
}

function ModelRow({
	providerId,
	model,
	setModel,
}: {
	providerId: string;
	model: string;
	setModel: (model: string) => void;
}) {
	return (
		<Setting
			label="model"
			hint="Defaults to this project's configured model. A survey is mostly reading, so a cheaper model is often enough."
		>
			<ModelPicker providerId={providerId} value={model} onChange={setModel} />
		</Setting>
	);
}

/** What will be true afterwards; both runs write to the board without asking again. */
function Consequences({ children }: { children: ReactNode }) {
	return (
		<ul
			className="list-disc space-y-1 pl-4"
			style={{
				color: "var(--mfw-fg-muted)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			{children}
		</ul>
	);
}
