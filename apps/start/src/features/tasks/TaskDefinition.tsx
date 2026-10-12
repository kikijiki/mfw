import { missingTemplateSections, type TaskTemplate } from "@mfw/core/template";
import type { ModelTier, ReopenCondition } from "@mfw/daemon/tasks/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { MarkdownField } from "../../components/MarkdownField";
import { Chip, Field, Panel } from "../../components/Page";
import { blockedReasonText } from "../../lib/format";
import { useKeyBindings } from "../../lib/keyboard";
import { useToast } from "../../lib/toast";
import type { RouterOutputs, TRPCError } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { ClarifyDialog } from "../clarify/ClarifyDialog";
import { VerdictHistory } from "../review/VerdictHistory";
import { DepsPicker } from "./DepsPicker";
import {
	VerificationBuilder,
	type VerificationPlan,
	verificationError,
} from "./DodBuilder";
import { completeReopenConditions, ReopenWhenEditor } from "./ReopenWhenEditor";
import { AttachmentsPanel, SpecPanel } from "./TaskExtras";

export type Task = NonNullable<RouterOutputs["tasks"]["get"]>;

interface Draft {
	title: string;
	body: string;
	type: Task["type"];
	priority: Task["priority"];
	size: Task["size"];
	labels: string[];
	dependsOn: string[];
	/** `id` is the checklist item id as loaded (kept so a save edits the same items). */
	criteria: { id?: string; text: string; checked: boolean }[];
	verification: VerificationPlan | null;
	requireReview: boolean;
	afterExpansion: "backlog" | "ready";
	/** One pattern per line, kept as typed so blank lines survive editing. */
	owns: string;
	/** "" = the project default. */
	modelTier: ModelTier | "";
	/** Routing pins; "" = the project decides. */
	provider: string;
	model: string;
	/** `local` (the project's placement decides), `ssh`, `ssh:<host>`, `runpod`. */
	executionTarget: string;
	reopenWhen: ReopenCondition[];
}

function toDraft(task: Task): Draft {
	return {
		title: task.title,
		body: task.body,
		type: task.type,
		priority: task.priority,
		size: task.size,
		labels: [...task.labels],
		dependsOn: [...task.dependsOn],
		criteria: task.criteria.map((c) => ({
			...(c.id !== undefined ? { id: c.id } : {}),
			text: c.text,
			checked: c.checked,
		})),
		verification: task.verification
			? {
					verifier: task.verification.verifier,
					checks: [...task.verification.checks],
				}
			: null,
		requireReview: task.requireReview,
		afterExpansion: task.afterExpansion,
		owns: task.owns.join("\n"),
		modelTier: task.modelTier ?? "",
		provider: task.provider ?? "",
		model: task.model ?? "",
		executionTarget: task.executionTarget,
		reopenWhen: task.reopenWhen.map((c) => ({ ...c })),
	};
}

function ownsPatterns(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Headings the task file parser owns: filled in their own panels, never
 * appended to the body. */
const MACHINE_SECTIONS = new Set([
	"acceptance criteria",
	"verification checks",
	"definition of done",
]);

const headingKey = (heading: string) =>
	heading.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The body with the template's missing sections appended, each with the
 * template's guidance as a starting point. A section whose heading is
 * already in the body (still holding the placeholder) is left for the
 * author to fill rather than duplicated.
 */
function withTemplateSections(
	body: string,
	template: TaskTemplate,
	missing: string[],
): string {
	const present = new Set(
		body
			.split("\n")
			.map((line) => /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)?.[1])
			.filter((h): h is string => h !== undefined)
			.map(headingKey),
	);
	const wanted = new Set(missing.map(headingKey));
	const added = template.sections
		.filter((section) => {
			const key = headingKey(section.heading);
			return wanted.has(key) && !present.has(key) && !MACHINE_SECTIONS.has(key);
		})
		.map((section) =>
			section.guidance
				? `## ${section.heading}\n\n${section.guidance}\n`
				: `## ${section.heading}\n`,
		);
	if (added.length === 0) return body;
	const head = body.trimEnd();
	return `${head}${head ? "\n\n" : ""}${added.join("\n")}`;
}

/**
 * The Definition tab: the task's structured editor. Every save carries
 * `baseRev`; a concurrent agent edit comes back as CONFLICT and raises the
 * conflict bar instead of the last writer winning. `TaskPage` keeps it
 * mounted (hidden) while another tab shows, so an unsaved draft survives a
 * tab switch.
 */
export function TaskDefinition({
	project,
	taskId,
	task,
	layout,
}: {
	project: string;
	taskId: string;
	task: Task;
	/** `board.schema` layout of the task type; `null` until known. Flat boards have no spec or attachments. */
	layout: "flat" | "directory" | null;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const allTasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	const sshHosts = useQuery(trpc.hosts.list.queryOptions());
	const knownTaskIds = useMemo(
		() => new Set((allTasks.data ?? []).map((t) => t.id)),
		[allTasks.data],
	);
	const [draft, setDraft] = useState<Draft | null>(() => toDraft(task));
	const [base, setBase] = useState<Draft | null>(() => toDraft(task));
	const [baseRev, setBaseRev] = useState<number | null>(task.contentRev);
	const [conflict, setConflict] = useState(false);
	const taskOwned = task?.claimedByRunId != null;
	const taskWaitingForAnswers = task?.draftPhase === "waiting_for_answers";
	const taskLocked = taskOwned || taskWaitingForAnswers;
	const [answering, setAnswering] = useState(false);
	const clarifyRun = useQuery({
		...trpc.clarify.getForTask.queryOptions({ project, taskId }),
		enabled: taskWaitingForAnswers,
	});

	const dirty = useMemo(
		() =>
			draft !== null && base !== null
				? JSON.stringify(draft) !== JSON.stringify(base)
				: false,
		[draft, base],
	);
	useBlocker({
		disabled: !dirty,
		enableBeforeUnload: dirty,
		shouldBlockFn: () =>
			!window.confirm("Discard the unsaved changes to this task?"),
	});

	// Adopt the server's copy only when not dirty; a dirty draft is never overwritten.
	useEffect(() => {
		if (!task) return;
		if (draft !== null && (dirty || task.contentRev === baseRev)) return;
		const next = toDraft(task);
		setDraft(next);
		setBase(next);
		setBaseRev(task.contentRev);
		setConflict(false);
	}, [task, draft, dirty, baseRev]);

	// A live `task.edited` refetches tasks.get; if dirty, contentRev moving is the §3.5 conflict case.
	const serverMovedOn =
		task !== null && baseRev !== null && task.contentRev !== baseRev;

	const save = useMutation(
		trpc.tasks.update.mutationOptions({
			meta: { label: "Save" },
			onSuccess: (updated) => {
				const next = toDraft(updated);
				setDraft(next);
				setBase(next);
				setBaseRev(updated.contentRev);
				setConflict(false);
				toast({ tone: "success", title: `${updated.id} saved` });
				void queryClient.invalidateQueries(
					trpc.tasks.list.queryFilter({ project }),
				);
			},
			onError: (error: TRPCError) => {
				if (error.data?.code === "CONFLICT") {
					setConflict(true);
					void queryClient.invalidateQueries(
						trpc.tasks.get.queryFilter({ project, id: taskId }),
					);
				}
			},
		}),
	);

	const templateQuery = useQuery({
		...trpc.tasks.template.queryOptions({
			project,
			type: draft?.type ?? "implementation",
		}),
		enabled: draft !== null && draft.type !== "epic",
	});
	const template = templateQuery.data ?? null;
	/** Checked against the draft as edited, so the warning clears as the
	 * author types; the saved row's `templateMissing` covers the gap until
	 * the template loads. Epics are containers and have no required sections. */
	const templateMissing = useMemo(() => {
		if (!draft || draft.type === "epic") return [];
		if (!template) {
			return draft.type === task?.type ? (task?.templateMissing ?? []) : [];
		}
		return missingTemplateSections(template, {
			body: draft.body,
			criteriaCount: draft.criteria.filter((c) => c.text.trim()).length,
			hasVerification: (draft.verification?.checks.length ?? 0) > 0,
		});
	}, [draft, template, task]);

	const validation = draft ? verificationError(draft.verification) : null;

	const doSave = (overrideRev?: number) => {
		if (!draft || !task || baseRev === null || taskLocked) return;
		save.mutate({
			project,
			id: taskId,
			baseRev: overrideRev ?? baseRev,
			patch: {
				title: draft.title,
				body: draft.body,
				type: draft.type,
				priority: draft.priority,
				size: draft.size,
				labels: draft.labels,
				dependsOn: draft.dependsOn,
				criteria: draft.criteria,
				verification: draft.verification,
				requireReview: draft.requireReview,
				owns: ownsPatterns(draft.owns),
				modelTier: draft.modelTier || null,
				provider: draft.provider.trim() || null,
				model: draft.model.trim() || null,
				...(draft.executionTarget !== task.executionTarget
					? { executionTarget: draft.executionTarget }
					: {}),
				reopenWhen: completeReopenConditions(draft.reopenWhen),
				...(task.status === "draft"
					? { afterExpansion: draft.afterExpansion }
					: {}),
			},
		});
	};

	useKeyBindings([
		{
			key: "mod+s",
			label: "Save task",
			group: "Task",
			allowInInput: true,
			enabled: dirty && !save.isPending && !taskLocked,
			run: () => doSave(),
		},
	]);

	if (!draft) return null;

	const depError = save.error?.message?.toLowerCase().includes("cycle")
		? save.error.message
		: null;
	// A board `error` rule refused the save (e.g. done with an unticked criterion).
	const ruleError =
		save.error?.data?.code === "PRECONDITION_FAILED" &&
		save.error.message.includes("refused by rule")
			? save.error.message
			: null;
	// Input validation names each bad pattern as "owns '<pattern>': <reason>".
	const ownsErrors = Object.values(
		save.error?.data?.zodError?.fieldErrors ?? {},
	)
		.flat()
		.filter((m): m is string => typeof m === "string" && m.startsWith("owns "));
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{clarifyRun.data ? (
				<ClarifyDialog
					project={project}
					runId={clarifyRun.data.runId}
					open={answering}
					onOpenChange={setAnswering}
				/>
			) : null}

			{task.status === "draft" ? (
				<div
					className="mx-3 mt-3 flex shrink-0 flex-wrap items-center gap-2 border p-2"
					style={{
						borderColor: "var(--mfw-border)",
						background: "var(--mfw-bg-subtle)",
					}}
				>
					<Chip
						tone={
							task.draftPhase === "failed"
								? "warn"
								: task.draftPhase === "waiting_for_answers"
									? "warn"
									: taskOwned
										? "info"
										: undefined
						}
					>
						{task.draftPhase === "failed"
							? "expansion failed"
							: task.draftPhase === "waiting_for_answers"
								? "waiting for answers"
								: taskOwned
									? "expanding"
									: task.draftPhase === "retrying"
										? "retry queued"
										: "queued for expansion"}
					</Chip>
					<span
						className="min-w-0 flex-1 basis-60 break-words"
						style={{ color: "var(--mfw-fg-muted)" }}
					>
						{taskOwned
							? `An agent is expanding this capture. It will ${task.afterExpansion === "backlog" ? "stay in backlog" : "move to ready"} when finished.`
							: task.draftPhase === "waiting_for_answers"
								? "Expansion is paused on questions. Your answers will continue this same task."
								: task.draftPhase === "failed"
									? "Expansion retries were exhausted. Edit and save the prompt to retry."
									: "This capture is waiting for expansion. You can still correct its prompt and destination."}
					</span>
					{taskWaitingForAnswers ? (
						<Button
							size="sm"
							variant="outline"
							disabled={!clarifyRun.data}
							onClick={() => setAnswering(true)}
						>
							Answer
						</Button>
					) : null}
					{!taskLocked ? (
						<Select
							value={draft.afterExpansion}
							onValueChange={(value) =>
								setDraft({
									...draft,
									afterExpansion: value as "backlog" | "ready",
								})
							}
						>
							<SelectTrigger
								className="w-full sm:w-44"
								aria-label="After expansion"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="ready">Move to ready</SelectItem>
								<SelectItem value="backlog">Keep in backlog</SelectItem>
							</SelectContent>
						</Select>
					) : null}
				</div>
			) : null}

			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto overscroll-contain p-3 lg:flex-row">
				<fieldset disabled={taskLocked} className="contents">
					<legend className="sr-only">Task fields</legend>
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						<Panel title="Basics">
							<div className="flex flex-col gap-2">
								<Input
									value={draft.title}
									aria-label="Title"
									onChange={(e) =>
										setDraft({ ...draft, title: e.target.value })
									}
								/>
								<div className="flex flex-wrap items-center gap-2">
									<Choice
										label="type"
										value={draft.type}
										options={["implementation", "spike", "epic", "maintenance"]}
										onChange={(type) =>
											setDraft({ ...draft, type: type as Draft["type"] })
										}
									/>
									<Choice
										label="priority"
										value={draft.priority}
										options={["critical", "high", "medium", "low"]}
										onChange={(priority) =>
											setDraft({
												...draft,
												priority: priority as Draft["priority"],
											})
										}
									/>
									<Choice
										label="size"
										value={draft.size ?? ""}
										options={["", "xs", "s", "m", "l", "xl"]}
										onChange={(size) =>
											setDraft({
												...draft,
												size: (size || null) as Draft["size"],
											})
										}
									/>
									<Choice
										label="model tier"
										value={draft.modelTier}
										options={["", "light", "standard", "strong"]}
										emptyLabel="default"
										onChange={(modelTier) =>
											setDraft({
												...draft,
												modelTier: modelTier as Draft["modelTier"],
											})
										}
									/>
								</div>
								<div className="grid gap-3 sm:grid-cols-2">
									<Field label="provider">
										<Input
											value={draft.provider}
											aria-label="Provider pin"
											autoComplete="off"
											placeholder="project default (claude-cli, codex-cli or an endpoint id)"
											onChange={(e) =>
												setDraft({ ...draft, provider: e.target.value })
											}
										/>
									</Field>
									<Field label="model">
										<Input
											value={draft.model}
											aria-label="Model pin"
											autoComplete="off"
											placeholder="from the tier and project"
											onChange={(e) =>
												setDraft({ ...draft, model: e.target.value })
											}
										/>
									</Field>
								</div>
								<Choice
									label="runs on"
									value={draft.executionTarget}
									options={executionTargetOptions(
										draft.executionTarget,
										(sshHosts.data ?? []).map((host) => host.config.id),
									)}
									onChange={(executionTarget) =>
										setDraft({ ...draft, executionTarget })
									}
								/>
								<Field label="labels">
									<Input
										value={draft.labels.join(", ")}
										aria-label="Labels, comma separated"
										placeholder="auth, backend"
										onChange={(e) =>
											setDraft({
												...draft,
												labels: e.target.value
													.split(",")
													.map((s) => s.trim())
													.filter(Boolean),
											})
										}
									/>
								</Field>
							</div>
						</Panel>

						<Panel title="Depends on">
							<DepsPicker
								project={project}
								value={draft.dependsOn}
								options={allTasks.data ?? []}
								selfId={taskId}
								error={depError}
								onChange={(dependsOn) => setDraft({ ...draft, dependsOn })}
							/>
						</Panel>

						<Panel title="Owns">
							<p className="mb-2" style={{ color: "var(--mfw-fg-muted)" }}>
								Repository paths or globs this task may edit, one per line.
								Tasks whose patterns overlap never run at the same time. Leave
								empty for no constraint.
							</p>
							<Textarea
								value={draft.owns}
								rows={3}
								aria-label="Owned paths, one pattern per line"
								aria-invalid={ownsErrors.length > 0 || undefined}
								placeholder={
									"packages/api/src/**\napps/start/src/features/tasks/*.tsx"
								}
								className="mfw-num"
								onChange={(e) => setDraft({ ...draft, owns: e.target.value })}
							/>
							{ownsErrors.length > 0 ? (
								<ul className="mt-1.5" style={{ color: "var(--mfw-warn)" }}>
									{ownsErrors.map((message) => (
										<li key={message} className="break-words">
											{message}
										</li>
									))}
								</ul>
							) : null}
						</Panel>

						<Panel title="Reopen when">
							<ReopenWhenEditor
								value={draft.reopenWhen}
								onChange={(reopenWhen) => setDraft({ ...draft, reopenWhen })}
							/>
						</Panel>

						<Panel title="Goal">
							{templateMissing.length > 0 ? (
								<div
									className="mb-2 flex flex-wrap items-center gap-2 border p-2"
									style={{
										borderColor:
											"color-mix(in oklch, var(--mfw-warn) 40%, transparent)",
										background:
											"color-mix(in oklch, var(--mfw-warn) 10%, transparent)",
									}}
								>
									<TriangleAlert
										aria-hidden
										className="size-4 shrink-0"
										style={{ color: "var(--mfw-warn)" }}
									/>
									<span className="min-w-0 flex-1 basis-60 break-words">
										The {draft.type} template needs:{" "}
										{templateMissing.join(", ")}. The task stays in backlog
										until they are filled in, unless moved to ready by hand.
									</span>
									{template ? (
										<Button
											size="xs"
											variant="outline"
											onClick={() =>
												setDraft({
													...draft,
													body: withTemplateSections(
														draft.body,
														template,
														templateMissing,
													),
												})
											}
										>
											Insert template
										</Button>
									) : null}
								</div>
							) : null}
							<MarkdownField
								value={draft.body}
								onChange={(body) => setDraft({ ...draft, body })}
								project={project}
								knownTaskIds={knownTaskIds}
								rows={8}
								ariaLabel="Goal and context"
								placeholder="Why this exists, and anything the agent needs to know."
								disabled={taskLocked}
								attachmentTaskId={taskId}
							/>
						</Panel>

						{layout === "directory" ? (
							<SpecPanel
								project={project}
								taskId={taskId}
								knownTaskIds={knownTaskIds}
							/>
						) : null}

						<Panel title="Acceptance criteria">
							<p className="mb-2" style={{ color: "var(--mfw-fg-muted)" }}>
								Observable outcomes, evaluated per candidate and never satisfied
								merely by running CI. Tick one once it is shown to hold; the
								board's rules can require every one ticked before done.
							</p>
							{ruleError && (
								<p
									role="alert"
									className="mb-2 whitespace-pre-wrap"
									style={{ color: "var(--mfw-critical)" }}
								>
									{ruleError}
								</p>
							)}
							<ul className="flex flex-col gap-1.5">
								{draft.criteria.map((criterion, index) => (
									<li
										// biome-ignore lint/suspicious/noArrayIndexKey: criteria are an ordered list edited in place
										key={index}
										className="flex items-center gap-2"
									>
										<span
											className="mfw-num w-5 shrink-0 text-right"
											style={{ color: "var(--mfw-fg-faint)" }}
										>
											{index + 1}.
										</span>
										<Checkbox
											aria-label={`Criterion ${index + 1} met`}
											checked={criterion.checked}
											disabled={taskLocked}
											onCheckedChange={(checked) =>
												setDraft({
													...draft,
													criteria: draft.criteria.map((c, i) =>
														i === index
															? { ...c, checked: checked === true }
															: c,
													),
												})
											}
										/>
										<Input
											className="flex-1"
											aria-label={`Criterion ${index + 1}`}
											placeholder="When a valid refresh token is presented, …"
											value={criterion.text}
											onChange={(e) =>
												setDraft({
													...draft,
													criteria: draft.criteria.map((c, i) =>
														i === index ? { ...c, text: e.target.value } : c,
													),
												})
											}
										/>
										<Button
											size="icon-xs"
											variant="ghost"
											aria-label={`Remove criterion ${index + 1}`}
											onClick={() =>
												setDraft({
													...draft,
													criteria: draft.criteria.filter(
														(_, i) => i !== index,
													),
												})
											}
										>
											<Trash2 aria-hidden />
										</Button>
									</li>
								))}
							</ul>
							<Button
								className="mt-2"
								size="xs"
								variant="outline"
								onClick={() =>
									setDraft({
										...draft,
										criteria: [...draft.criteria, { text: "", checked: false }],
									})
								}
							>
								<Plus aria-hidden /> Criterion
							</Button>
						</Panel>

						<Panel title="Task verification checks">
							<VerificationBuilder
								value={draft.verification}
								taskType={draft.type}
								onChange={(verification) =>
									setDraft({ ...draft, verification })
								}
							/>
							{/* Always shown, off by default, so every task answers "will a human see this?". */}
							<label
								className="mt-3 flex items-center gap-2"
								htmlFor="require-review"
							>
								<input
									id="require-review"
									type="checkbox"
									checked={draft.requireReview}
									onChange={(e) =>
										setDraft({ ...draft, requireReview: e.target.checked })
									}
								/>
								<span>Require human review before merging</span>
							</label>
							<p
								className="mt-1 text-xs"
								style={{ color: "var(--mfw-fg-faint)" }}
							>
								Project merge checks always apply. Task checks add focused
								evidence; semantic acceptance is decided by the configured
								assisted or human review policy.
							</p>
						</Panel>
					</div>
				</fieldset>

				<div className="flex min-w-0 w-full shrink-0 flex-col gap-3 lg:w-80">
					{layout === "directory" ? (
						<AttachmentsPanel project={project} taskId={taskId} />
					) : null}

					<VerdictHistory project={project} taskId={taskId} />

					{task.blockedReason ? (
						<Panel title="Blocked because">
							<p className="break-words" style={{ color: "var(--mfw-warn)" }}>
								{blockedReasonText(task.blockedReason)}
							</p>
						</Panel>
					) : null}
				</div>
			</div>

			{(conflict || (serverMovedOn && dirty)) && task ? (
				<div
					className="flex flex-wrap items-center gap-2 border-t px-3 py-2"
					style={{
						borderColor:
							"color-mix(in oklch, var(--mfw-warn) 40%, transparent)",
						background: "color-mix(in oklch, var(--mfw-warn) 14%, transparent)",
					}}
				>
					<TriangleAlert
						aria-hidden
						className="size-4 shrink-0"
						style={{ color: "var(--mfw-warn)" }}
					/>
					<span className="min-w-0 flex-1 break-words">
						Someone else changed this task while you were editing (rev {baseRev}{" "}
						→ {task.contentRev}). Your edits are still here and have not been
						sent.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							// Reload: adopt the server's copy, discarding the local draft (explicit).
							const next = toDraft(task);
							setDraft(next);
							setBase(next);
							setBaseRev(task.contentRev);
							setConflict(false);
						}}
					>
						Reload theirs
					</Button>
					<Button
						size="sm"
						disabled={save.isPending || taskLocked}
						onClick={() => doSave(task.contentRev)}
					>
						Keep mine
					</Button>
				</div>
			) : null}

			{dirty ? (
				<div
					className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t px-3 py-2"
					style={{
						borderColor: "var(--mfw-border)",
						background: "var(--mfw-bg-subtle)",
					}}
				>
					<span style={{ color: "var(--mfw-warn)" }} aria-live="polite">
						Unsaved changes
					</span>
					{validation ? (
						<span
							className="min-w-0 break-words"
							style={{ color: "var(--mfw-warn)" }}
						>
							· {validation}
						</span>
					) : null}
					<span className="flex-1" />
					<Button
						size="sm"
						variant="ghost"
						disabled={save.isPending}
						onClick={() => base && setDraft(base)}
					>
						Discard
					</Button>
					<Button
						size="sm"
						disabled={save.isPending || Boolean(validation) || taskLocked}
						onClick={() => doSave()}
					>
						{save.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function Choice({
	label,
	value,
	options,
	emptyLabel = "-",
	onChange,
}: {
	label: string;
	value: string;
	options: string[];
	/** How the "" option reads. */
	emptyLabel?: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="flex items-center gap-1.5">
			<span style={{ color: "var(--mfw-fg-muted)" }}>{label}</span>
			<select
				className="mfw-focus min-h-8 border px-1.5"
				style={{
					background: "var(--mfw-bg-raised)",
					borderColor: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					color: "var(--mfw-fg)",
				}}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				{options.map((option) => (
					<option key={option} value={option}>
						{option === "" ? emptyLabel : option}
					</option>
				))}
			</select>
		</label>
	);
}

/**
 * The task's `execution_target` choices: `local` lets the project's placement
 * decide (this machine unless the project routes to SSH), `ssh` any matching
 * host, `ssh:<id>` one host, `runpod` the RunPod target.
 */
export function executionTargetOptions(
	current: string,
	hostIds: readonly string[],
): string[] {
	return [
		...new Set([
			"local",
			"ssh",
			...hostIds.map((id) => `ssh:${id}`),
			"runpod",
			current,
		]),
	];
}
