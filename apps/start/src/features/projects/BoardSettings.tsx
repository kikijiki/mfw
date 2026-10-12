import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { TipSelect } from "~/components/ui/tooltip";
import { ErrorState } from "../../components/ErrorState";
import { StatusIcon, TaskTypeIcon } from "../../components/icons";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import {
	addRow,
	BOARD_ROLES,
	type BoardDraft,
	type BoardPatch,
	type BoardRole,
	type BoardTemplateView,
	type BoardView,
	buildPatch,
	draftFromTemplate,
	draftFromView,
	draftProblems,
	isEmptyPatch,
	moveRow,
	ROLE_HINTS,
	removedStatuses,
	removeRow,
	roleAdvice,
	setRowRole,
	setRowValue,
	setTypes,
	unresolvedRemovals,
} from "./boardDraft";

type Preview = RouterOutputs["boardConfig"]["preview"];

const roleLabel = (role: string) =>
	role.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const selectClass =
	"mfw-focus h-8 rounded-md border bg-transparent px-2 text-sm";

/**
 * Project settings, "Board": the statuses of the board in order with the
 * daemon role each plays, the task types and the hierarchy depth. Edits go
 * through `boardConfig.preview` (validate + diff, nothing written) and
 * `boardConfig.save`; a status that tasks still use is never dropped without
 * saying where those tasks go.
 */
export function BoardSettings({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const config = useQuery(trpc.boardConfig.get.queryOptions({ project }));
	const templates = useQuery(trpc.boardConfig.templates.queryOptions());
	const view = config.data;

	const [draft, setDraft] = useState<BoardDraft | null>(null);
	const [preview, setPreview] = useState<{
		key: string;
		result: Preview;
	} | null>(null);
	const [template, setTemplate] = useState("");

	// Re-seed whenever the file on disk changes (first load, after a save).
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the file text on purpose
	useEffect(() => {
		if (view) {
			setDraft(draftFromView(view));
			setPreview(null);
		}
	}, [view?.yaml]);

	const previewMutation = useMutation(
		trpc.boardConfig.preview.mutationOptions({
			meta: { label: "Preview board change" },
		}),
	);
	const saveMutation = useMutation(
		trpc.boardConfig.save.mutationOptions({
			meta: { label: "Save board" },
			onSuccess: (result) => {
				if (result.ok) {
					toast({
						tone: "success",
						title: "Board saved",
						description: result.needsRestart
							? "The daemon reads board.yaml at attach: restart for it to take effect."
							: undefined,
					});
					void queryClient.invalidateQueries(
						trpc.boardConfig.get.queryFilter({ project }),
					);
					void queryClient.invalidateQueries(
						trpc.board.schema.queryFilter({ project }),
					);
				} else {
					setPreview({ key: "", result });
				}
			},
		}),
	);

	const patch: BoardPatch = useMemo(
		() => (view && draft ? buildPatch(draft, view) : {}),
		[view, draft],
	);
	const patchKey = JSON.stringify(patch);
	const problems = view && draft ? draftProblems(draft, view) : [];
	const unresolved = view && draft ? unresolvedRemovals(draft, view) : [];
	const dirty = !isEmptyPatch(patch);
	const previewed =
		preview !== null && preview.key === patchKey && preview.result.ok;

	if (config.error) {
		return (
			<Panel title="Board">
				<ErrorState title="Could not read this board" error={config.error} />
			</Panel>
		);
	}
	if (!view || !draft) {
		return (
			<Panel title="Board">
				<LoadingRows rows={3} />
			</Panel>
		);
	}
	if (view.unsupported) {
		return (
			<Panel title="Board">
				<p style={{ color: "var(--mfw-fg-muted)" }}>
					This board cannot be edited here: {view.unsupported}.
				</p>
				<RawYaml yaml={view.yaml} />
			</Panel>
		);
	}

	const update = (next: BoardDraft) => {
		setDraft(next);
		setPreview(null);
	};
	const removed = removedStatuses(draft, view).filter(
		(g) => g.renamedTo === null,
	);
	const templateView = (id: string): BoardTemplateView | null => {
		const t = templates.data?.find((x) => x.id === id);
		return t
			? {
					statuses: t.statuses as { value: string; role: BoardRole }[],
					types: t.types,
				}
			: null;
	};

	return (
		<Panel
			title="Board"
			actions={
				<span
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{view.path}
				</span>
			}
		>
			<div className="flex flex-col gap-4">
				<p
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					The statuses of this project's tasks, in column order, and the role
					each plays for mfw. The daemon reads <code>board.yaml</code> when the
					project attaches, so a saved change takes effect after a restart.
				</p>

				<section aria-label="Statuses" className="flex flex-col gap-2">
					<h3 style={{ fontSize: "var(--mfw-text-sm)", fontWeight: 600 }}>
						Statuses
					</h3>
					<ol className="flex flex-col gap-1.5">
						{draft.rows.map((row, i) => (
							<li key={row.key} className="flex flex-wrap items-center gap-2">
								<StatusIcon statusRole={row.role} value={row.value} />
								<Input
									aria-label={`Status ${i + 1} name`}
									className="h-8 w-44"
									value={row.value}
									onChange={(e) =>
										update(setRowValue(draft, row.key, e.target.value))
									}
								/>
								<TipSelect
									aria-label={`Role of ${row.value || `status ${i + 1}`}`}
									className={selectClass}
									value={row.role}
									tip={ROLE_HINTS[row.role]}
									onChange={(e) =>
										update(
											setRowRole(draft, row.key, e.target.value as BoardRole),
										)
									}
								>
									{BOARD_ROLES.map((role) => (
										<option key={role} value={role}>
											{roleLabel(role)}
										</option>
									))}
								</TipSelect>
								{row.original && row.original !== row.value.trim() ? (
									<Chip tone="warn">renames {row.original}</Chip>
								) : null}
								{row.original === null ? <Chip tone="info">new</Chip> : null}
								{row.tasks > 0 ? (
									<span
										style={{
											color: "var(--mfw-fg-faint)",
											fontSize: "var(--mfw-text-xs)",
										}}
									>
										{row.tasks} task{row.tasks === 1 ? "" : "s"}
									</span>
								) : null}
								<span className="flex-1" />
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Move ${row.value} up`}
									disabled={i === 0}
									onClick={() => update(moveRow(draft, row.key, -1))}
								>
									<ArrowUp aria-hidden className="size-3.5" />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Move ${row.value} down`}
									disabled={i === draft.rows.length - 1}
									onClick={() => update(moveRow(draft, row.key, 1))}
								>
									<ArrowDown aria-hidden className="size-3.5" />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Remove ${row.value}`}
									onClick={() => update(removeRow(draft, row.key))}
								>
									<Trash2 aria-hidden className="size-3.5" />
								</Button>
							</li>
						))}
					</ol>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() => update(addRow(draft))}
						>
							<Plus aria-hidden className="size-3.5" /> Add status
						</Button>
						<select
							aria-label="Board template"
							className={selectClass}
							value={template}
							onChange={(e) => setTemplate(e.target.value)}
						>
							<option value="">Start from a template…</option>
							{templates.data?.map((t) => (
								<option key={t.id} value={t.id}>
									{t.title}
								</option>
							))}
						</select>
						<Button
							size="sm"
							variant="outline"
							disabled={!templateView(template)}
							onClick={() => {
								const t = templateView(template);
								if (t) update(draftFromTemplate(draft, view, t));
							}}
						>
							Use template statuses
						</Button>
					</div>
				</section>

				{removed.length > 0 ? (
					<section
						aria-label="Removed statuses"
						className="flex flex-col gap-1.5"
					>
						<h3 style={{ fontSize: "var(--mfw-text-sm)", fontWeight: 600 }}>
							Removed statuses
						</h3>
						{removed.map((g) => (
							<div key={g.status} className="flex flex-wrap items-center gap-2">
								<span className="font-mono">{g.status}</span>
								{g.tasks > 0 ? (
									<>
										<span style={{ color: "var(--mfw-warn)" }}>
											{g.tasks} task{g.tasks === 1 ? "" : "s"} move to
										</span>
										<select
											aria-label={`Move tasks of ${g.status} to`}
											className={selectClass}
											value={draft.remap[g.status] ?? ""}
											onChange={(e) =>
												update({
													...draft,
													remap: { ...draft.remap, [g.status]: e.target.value },
												})
											}
										>
											<option value="">Choose a status…</option>
											{draft.rows
												.filter((r) => r.value.trim())
												.map((r) => (
													<option key={r.key} value={r.value.trim()}>
														{r.value.trim()}
													</option>
												))}
										</select>
									</>
								) : (
									<span style={{ color: "var(--mfw-fg-faint)" }}>
										no tasks use it
									</span>
								)}
							</div>
						))}
					</section>
				) : null}

				<section aria-label="Task types" className="flex flex-col gap-2">
					<h3 style={{ fontSize: "var(--mfw-text-sm)", fontWeight: 600 }}>
						Task types
					</h3>
					{view.taskTypes === null ? (
						<p style={{ color: "var(--mfw-fg-faint)" }}>
							This board has no task <code>type</code> field.
						</p>
					) : (
						<div className="flex flex-wrap items-center gap-2">
							{draft.types.map((t, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: names are edited in place
									key={i}
									className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5"
									style={{ borderColor: "var(--mfw-border)" }}
								>
									<TaskTypeIcon type={t} />
									<Input
										aria-label={`Task type ${i + 1}`}
										className="h-7 w-32"
										value={t}
										onChange={(e) =>
											update(
												setTypes(
													draft,
													draft.types.map((x, j) =>
														j === i ? e.target.value : x,
													),
												),
											)
										}
									/>
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Remove task type ${t}`}
										onClick={() =>
											update(
												setTypes(
													draft,
													draft.types.filter((_, j) => j !== i),
												),
											)
										}
									>
										<Trash2 aria-hidden className="size-3.5" />
									</Button>
								</span>
							))}
							<Button
								size="sm"
								variant="outline"
								onClick={() => update(setTypes(draft, [...draft.types, ""]))}
							>
								<Plus aria-hidden className="size-3.5" /> Add type
							</Button>
						</div>
					)}
				</section>

				<section aria-label="Hierarchy" className="flex flex-col gap-1.5">
					<h3 style={{ fontSize: "var(--mfw-text-sm)", fontWeight: 600 }}>
						Hierarchy
					</h3>
					{view.hierarchy ? (
						<div className="flex flex-wrap items-center gap-2">
							<label htmlFor="board-max-depth">Maximum depth</label>
							<Input
								id="board-max-depth"
								type="number"
								min={1}
								className="h-8 w-24"
								placeholder="no limit"
								value={draft.maxDepth}
								onChange={(e) => update({ ...draft, maxDepth: e.target.value })}
							/>
							<span
								style={{
									color: "var(--mfw-fg-faint)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								{view.hierarchy.ruleCount} parent/child rule
								{view.hierarchy.ruleCount === 1 ? "" : "s"}
								{view.hierarchy.kindField
									? ` on '${view.hierarchy.kindField}' (${view.hierarchy.kinds.join(", ")})`
									: ""}
								; the rules are edited in board.yaml.
							</span>
						</div>
					) : (
						<p style={{ color: "var(--mfw-fg-faint)" }}>
							This board declares no hierarchy.
						</p>
					)}
				</section>

				{[...problems, ...roleAdvice(draft)].length > 0 ? (
					<ul aria-label="Board problems" className="list-disc pl-5">
						{problems.map((p) => (
							<li key={p} style={{ color: "var(--mfw-critical)" }}>
								{p}
							</li>
						))}
						{roleAdvice(draft).map((p) => (
							<li key={p} style={{ color: "var(--mfw-warn)" }}>
								{p}
							</li>
						))}
					</ul>
				) : null}

				<PreviewResult preview={preview?.result ?? null} />

				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={
							!dirty ||
							problems.length > 0 ||
							unresolved.length > 0 ||
							previewMutation.isPending
						}
						onClick={() =>
							previewMutation.mutate(
								{ project, patch },
								{
									onSuccess: (result) => setPreview({ key: patchKey, result }),
								},
							)
						}
					>
						{previewMutation.isPending ? "Checking…" : "Preview changes"}
					</Button>
					<Button
						size="sm"
						disabled={!previewed || saveMutation.isPending}
						onClick={() => saveMutation.mutate({ project, patch })}
					>
						{saveMutation.isPending ? "Applying…" : "Apply"}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={!dirty}
						onClick={() => update(draftFromView(view))}
					>
						Discard
					</Button>
					{unresolved.length > 0 ? (
						<span style={{ color: "var(--mfw-warn)" }}>
							Choose where the tasks of {unresolved.join(", ")} go.
						</span>
					) : null}
				</div>

				<RawYaml yaml={view.yaml} />
			</div>
		</Panel>
	);
}

function PreviewResult({ preview }: { preview: Preview | null }) {
	if (!preview) return null;
	if (!preview.ok) {
		return (
			<div role="alert" className="flex flex-col gap-1">
				<strong style={{ color: "var(--mfw-critical)" }}>
					This change cannot be applied
				</strong>
				<ul className="list-disc pl-5">
					{preview.errors.map((e) => (
						<li key={e} style={{ color: "var(--mfw-critical)" }}>
							{e}
						</li>
					))}
				</ul>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<strong>
				{preview.changed
					? `Will change board.yaml${
							preview.remaps.length > 0
								? ` and move ${preview.remaps.length} task${preview.remaps.length === 1 ? "" : "s"}`
								: ""
						}`
					: "No change"}
			</strong>
			{preview.warnings.length > 0 ? (
				<ul className="list-disc pl-5">
					{preview.warnings.map((w) => (
						<li key={w} style={{ color: "var(--mfw-warn)" }}>
							{w}
						</li>
					))}
				</ul>
			) : null}
			{preview.diff.length > 0 ? (
				<pre
					className="max-h-72 overflow-auto rounded-md border p-2"
					style={{
						borderColor: "var(--mfw-border)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{preview.diff.map((l, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: a diff is positional
							key={i}
							style={{
								color:
									l.op === "+"
										? "var(--mfw-success)"
										: l.op === "-"
											? "var(--mfw-critical)"
											: "var(--mfw-fg-muted)",
							}}
						>
							{l.op} {l.text}
						</div>
					))}
				</pre>
			) : null}
		</div>
	);
}

function RawYaml({ yaml }: { yaml: string }) {
	return (
		<details>
			<summary style={{ cursor: "pointer", color: "var(--mfw-fg-muted)" }}>
				Raw board.yaml (read-only)
			</summary>
			<pre
				className="mt-2 max-h-96 overflow-auto rounded-md border p-2"
				style={{
					borderColor: "var(--mfw-border)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				{yaml}
			</pre>
		</details>
	);
}

export type { BoardView };
