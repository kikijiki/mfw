import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import {
	BUDGET_UNITS,
	BUDGET_WINDOWS,
	type BudgetDraft,
	type BudgetKind,
	type BudgetRowLike,
	barPercent,
	blankDraft,
	budgetTone,
	consequenceOf,
	draftOf,
	spendReading,
	validateBudgetDraft,
} from "./budgetsDraft";
import { Segmented, Select, Setting } from "./controls";

/**
 * Budgets: spend ceilings over the ledger, per project and per machine. Each
 * row reads current spend against its limit for the open window; saving or
 * removing goes through `budgets.set`. Raising a limit lifts an exhausted
 * budget on the daemon's next evaluation.
 */
export function BudgetsPanel({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const budgets = useQuery(trpc.budgets.list.queryOptions({ project }));
	const [draft, setDraft] = useState<BudgetDraft | null>(null);
	const [error, setError] = useState<string | null>(null);

	const set = useMutation(
		trpc.budgets.set.mutationOptions({
			meta: { label: "Save budget" },
			onSuccess: () => {
				setDraft(null);
				setError(null);
				toast({ tone: "success", title: "Budget saved" });
			},
			onSettled: () =>
				void queryClient.invalidateQueries(
					trpc.budgets.list.queryFilter({ project }),
				),
		}),
	);

	const save = () => {
		if (!draft) return;
		try {
			set.mutate({ project, ...validateBudgetDraft(draft) });
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	const remove = (row: BudgetRowLike) =>
		set.mutate({
			project,
			scope: row.scope,
			kind: row.kind,
			key: row.key,
			entry: null,
		});

	const rows = (budgets.data ?? []) as BudgetRowLike[];

	return (
		<Panel
			title="Budgets"
			actions={
				draft === null ? (
					<Button
						size="xs"
						variant="outline"
						onClick={() => setDraft(blankDraft())}
					>
						<Plus aria-hidden /> Budget
					</Button>
				) : null
			}
		>
			<p
				className="mb-3"
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				Ceilings over recorded spend. A project budget can only tighten a
				machine one. Windows are UTC.
			</p>
			{budgets.isLoading ? (
				<LoadingRows rows={2} />
			) : budgets.error ? (
				<ErrorState
					title="Could not list budgets"
					error={budgets.error}
					onRetry={() => void budgets.refetch()}
				/>
			) : rows.length === 0 && draft === null ? (
				<Empty
					title="No budgets configured"
					description="Add a ceiling for a RunPod account, a host, an agent account or the brain's own spend."
				/>
			) : (
				<ul className="flex flex-col gap-3">
					{rows.map((row) => (
						<BudgetRow
							key={`${row.scope}:${row.kind}:${row.key}:${row.unit}`}
							row={row}
							onEdit={() => setDraft(draftOf(row))}
							onRemove={() => remove(row)}
						/>
					))}
				</ul>
			)}

			{draft ? (
				<BudgetForm
					draft={draft}
					error={error}
					saving={set.isPending}
					onChange={setDraft}
					onSave={save}
					onCancel={() => {
						setDraft(null);
						setError(null);
					}}
				/>
			) : null}
		</Panel>
	);
}

function BudgetRow({
	row,
	onEdit,
	onRemove,
}: {
	row: BudgetRowLike;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const tone = budgetTone(row);
	return (
		<li
			className="flex flex-col gap-1.5 border-b pb-3 last:border-b-0 last:pb-0"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Mono value={row.key} />
				<Chip>{row.kind}</Chip>
				<Chip>{row.scope}</Chip>
				<Chip>per {row.window}</Chip>
				{row.phase === "exhausted" ? (
					<Chip tone="critical">exhausted</Chip>
				) : row.phase === "warned" ? (
					<Chip tone="warn">near limit</Chip>
				) : null}
				<span className="flex-1" />
				<Button size="xs" variant="ghost" onClick={onEdit}>
					Edit
				</Button>
				<Button size="xs" variant="destructive" onClick={onRemove}>
					Remove
				</Button>
			</div>
			<div
				role="progressbar"
				aria-label={`${row.key} spend`}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={barPercent(row)}
				style={{
					height: 6,
					borderRadius: 3,
					background: "var(--mfw-bg-subtle)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						width: `${barPercent(row)}%`,
						height: "100%",
						background:
							tone === "critical"
								? "var(--mfw-critical)"
								: tone === "warn"
									? "var(--mfw-warn)"
									: "var(--mfw-ok)",
					}}
				/>
			</div>
			<div
				className="flex flex-wrap items-center gap-2"
				style={{ fontSize: "var(--mfw-text-xs)" }}
			>
				<span className="mfw-num">{spendReading(row)}</span>
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					resets <RelativeTime value={row.windowResetsAt} />
				</span>
			</div>
			<span
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				{consequenceOf(row)}
			</span>
		</li>
	);
}

function BudgetForm({
	draft,
	error,
	saving,
	onChange,
	onSave,
	onCancel,
}: {
	draft: BudgetDraft;
	error: string | null;
	saving: boolean;
	onChange: (next: BudgetDraft) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	return (
		<div
			className="mt-3 flex flex-col gap-3 border p-3"
			style={{
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-md)",
				background: "var(--mfw-bg-subtle)",
			}}
		>
			<div className="flex flex-wrap items-end gap-3">
				<Setting label="kind">
					<Segmented
						label="Budget kind"
						value={draft.kind}
						options={["resource", "agent", "brain"]}
						onChange={(kind) =>
							onChange({
								...blankDraft(kind as BudgetKind),
								scope: draft.scope,
								window: draft.window,
							})
						}
					/>
				</Setting>
				<Setting
					label="scope"
					hint="Machine budgets sum every project's spend and bound this project's."
				>
					<Segmented
						label="Budget scope"
						value={draft.scope}
						options={["project", "machine"]}
						onChange={(scope) =>
							onChange({ ...draft, scope: scope as BudgetDraft["scope"] })
						}
					/>
				</Setting>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				{draft.kind === "brain" ? null : (
					<Setting
						label={draft.kind === "agent" ? "account" : "resource"}
						hint={
							draft.kind === "agent"
								? "A provider key: claude-cli, codex-cli, codex-cli@<endpoint>."
								: "runpod:<account>, host:<id>, or a project resource id. A trailing * matches a prefix."
						}
					>
						<Input
							aria-label="Budget key"
							placeholder={
								draft.kind === "agent" ? "claude-cli" : "runpod:main"
							}
							autoComplete="off"
							spellCheck={false}
							value={draft.key}
							onChange={(e) => onChange({ ...draft, key: e.target.value })}
						/>
					</Setting>
				)}
				<Setting
					label="window"
					hint="UTC. hour, day, week, month, or 5h, 12h, 7d."
				>
					<div className="flex flex-wrap items-center gap-2">
						<Select
							ariaLabel="Budget window preset"
							value={
								(BUDGET_WINDOWS as readonly string[]).includes(draft.window)
									? draft.window
									: "custom"
							}
							options={[...BUDGET_WINDOWS, "custom"]}
							onChange={(w) =>
								onChange({ ...draft, window: w === "custom" ? "5h" : w })
							}
						/>
						{(BUDGET_WINDOWS as readonly string[]).includes(
							draft.window,
						) ? null : (
							<Input
								aria-label="Budget window"
								className="max-w-24"
								value={draft.window}
								onChange={(e) => onChange({ ...draft, window: e.target.value })}
							/>
						)}
					</div>
				</Setting>
				<Setting label="limit">
					<div className="flex flex-wrap items-center gap-2">
						<Input
							type="number"
							min={0}
							aria-label="Budget limit"
							className="max-w-40"
							value={draft.limit}
							onChange={(e) => onChange({ ...draft, limit: e.target.value })}
						/>
						<Select
							ariaLabel="Budget unit"
							value={draft.unit}
							options={BUDGET_UNITS}
							onChange={(unit) =>
								onChange({ ...draft, unit: unit as BudgetDraft["unit"] })
							}
						/>
					</div>
				</Setting>
				<Setting
					label="warn at (%)"
					hint="Wakes the brain once per window so it can economise. Empty = no warning."
				>
					<Input
						type="number"
						min={1}
						max={100}
						aria-label="Budget warn at percent"
						className="max-w-32"
						value={draft.warnPercent}
						onChange={(e) =>
							onChange({ ...draft, warnPercent: e.target.value })
						}
					/>
				</Setting>
				{draft.kind === "resource" ? (
					<Setting
						label="live runs at the limit"
						hint="stop: interrupt then kill now. finish_turn: let the current turn end first."
					>
						<Segmented
							label="Live run policy"
							value={draft.liveRunPolicy}
							options={["stop", "finish_turn"]}
							onChange={(p) =>
								onChange({
									...draft,
									liveRunPolicy: p as BudgetDraft["liveRunPolicy"],
								})
							}
						/>
					</Setting>
				) : null}
			</div>
			{error ? (
				<p role="alert" style={{ color: "var(--mfw-critical)" }}>
					{error}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button size="sm" onClick={onSave} disabled={saving}>
					Save
				</Button>
				<Button size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
