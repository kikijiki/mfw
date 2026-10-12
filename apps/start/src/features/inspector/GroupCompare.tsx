import { useQuery } from "@tanstack/react-query";
import { Plus, Square, Star } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { TipLi, TipSpan, TipSummary } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { HarnessBadge } from "../../components/agent/HarnessBadge";
import { lookForRun, shortModel } from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { Glyph } from "../../components/icons";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import { formatCost, formatDuration } from "../../lib/format";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { AddAttemptDialog } from "../agents/RerouteDialog";
import { StopAllDialog, useNodeActions } from "../agents/useNodeActions";
import { DiffView, type ReviewFile } from "../review/DiffView";
import { countChanges, diffLines } from "../review/diff";
import {
	diffTotals,
	type GroupAttempt,
	type GroupData,
	liveAttemptIds,
	selectGate,
} from "./groupGate";

/**
 * The group inspector (design §7.3): the attempts of one competing group side
 * by side, one column each: route, state, cost, the checks, scope, the review
 * verdict, the diff and the agent's last word. `Select winner` is enabled only
 * where the server would accept it (verified, settled, inside scope, review
 * allowed) and shows the server's own refusal and fix text otherwise.
 * Choosing is a person overriding the brain: it is recorded as a human
 * decision and goes through the same gates and merge queue as the brain's.
 */

const muted = { color: "var(--mfw-fg-muted)" } as const;
const faint = { color: "var(--mfw-fg-faint)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;

const STATUS_LABEL: Record<string, string> = {
	open: "open",
	selecting: "winner chosen, merging",
	merged: "merged",
	abandoned: "abandoned",
};

export function GroupCompare({
	project,
	groupId,
	onSelectNode,
}: {
	project: string;
	groupId: string;
	onSelectNode?: (ref: string) => void;
}) {
	const trpc = useTRPC();
	const query = useQuery(trpc.groups.get.queryOptions({ project, groupId }));
	if (query.isPending) return <LoadingRows rows={4} />;
	if (query.isError) {
		return (
			<ErrorState error={query.error} onRetry={() => void query.refetch()} />
		);
	}
	return (
		<GroupCompareView
			project={project}
			group={query.data}
			{...(onSelectNode ? { onSelectNode } : {})}
		/>
	);
}

/** The data-in half: renders from a `groups.get` result, so a test can drive it without a daemon. */
export function GroupCompareView({
	project,
	group,
	onSelectNode,
}: {
	project: string;
	group: GroupData;
	onSelectNode?: (ref: string) => void;
}) {
	const live = liveAttemptIds(group);
	const actions = useNodeActions({
		kind: "group",
		project,
		groupId: group.id,
		taskId: group.taskId,
		label: group.id,
		liveRunIds: live,
	}).group;
	const open = group.status === "open";
	const decided = group.selectedBy;
	const open_ = (ref: string) => (onSelectNode ? onSelectNode(ref) : undefined);

	if (group.attempts.length === 0) {
		return (
			<Empty
				title="No attempts yet"
				description="This group has no runs; the brain or you can add one."
			/>
		);
	}

	return (
		<div className="flex min-w-0 flex-col gap-3 p-3" data-group={group.id}>
			<div
				className="flex flex-wrap items-center gap-x-3 gap-y-1"
				style={small}
			>
				<Glyph name="compete" label="competing attempts" />
				<strong>
					{group.kind === "competing" ? "Competing attempts" : "Group"}
				</strong>
				<Chip tone={group.status === "abandoned" ? "warn" : "neutral"}>
					{STATUS_LABEL[group.status] ?? group.status}
				</Chip>
				<span style={muted}>
					{group.createdBy === "human" ? (
						"started by a person"
					) : (
						<>
							spawned by{" "}
							<AppLink to={href.board(project, { node: group.createdBy })}>
								{group.createdBy}
							</AppLink>
						</>
					)}
				</span>
				<AppLink to={href.board(project, { node: `task:${group.taskId}` })}>
					{group.taskId}
				</AppLink>
				<span className="flex-1" />
				{open ? (
					<>
						<Button
							size="xs"
							variant="outline"
							onClick={() => actions.addAttempt.setOpen(true)}
						>
							<Plus aria-hidden />
							Add attempt…
						</Button>
						{live.length > 0 ? (
							<Button
								size="xs"
								variant="outline"
								disabled={actions.stopAll.pending}
								onClick={actions.stopAll.request}
							>
								<Square aria-hidden />
								Stop all
							</Button>
						) : null}
					</>
				) : null}
			</div>

			<SelectionNote group={group} decided={decided} />

			{actions.selectWinner.error ? (
				<p
					role="alert"
					data-testid="select-error"
					style={{ ...small, color: "var(--mfw-warn)" }}
				>
					{actions.selectWinner.error}
				</p>
			) : null}

			<div className="min-w-0 overflow-x-auto">
				<table
					className="w-full border-collapse"
					style={{
						...small,
						tableLayout: "fixed",
						minWidth: `${group.attempts.length * 260}px`,
					}}
				>
					<colgroup>
						<col style={{ width: "6.5rem" }} />
						{group.attempts.map((a) => (
							<col key={a.runId} />
						))}
					</colgroup>
					<thead>
						<tr>
							<th />
							{group.attempts.map((a) => (
								<th
									key={a.runId}
									scope="col"
									className="px-2 pb-2 text-left align-top"
								>
									<AttemptHeader
										attempt={a}
										onOpen={() => open_(`run:${a.runId}`)}
										project={project}
									/>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						<Row attempts={group.attempts} label="Route">
							{(a) => (
								<span className="flex flex-wrap items-center gap-1">
									{a.harness ? <HarnessBadge harness={a.harness} /> : null}
									<span className="mfw-num">{shortModel(a.model)}</span>
									{a.effort ? <span style={muted}>{a.effort}</span> : null}
									{a.host ? <span style={muted}>on {a.host}</span> : null}
								</span>
							)}
						</Row>
						<Row attempts={group.attempts} label="State">
							{(a) => {
								const look = lookForRun({
									state: a.state as never,
									activity: a.activity,
								});
								return <StateGlyph look={look} showLabel />;
							}}
						</Row>
						<Row attempts={group.attempts} label="Duration">
							{(a) => (
								<span className="mfw-num">
									{formatDuration(
										(a.finishedAt ?? new Date()).getTime() -
											a.startedAt.getTime(),
									)}
								</span>
							)}
						</Row>
						<Row attempts={group.attempts} label="Cost">
							{(a) => <span className="mfw-num">{formatCost(a.costUsd)}</span>}
						</Row>
						<Row attempts={group.attempts} label="Verify">
							{(a) =>
								a.checks.length > 0 ? (
									<ul className="m-0 flex list-none flex-col p-0">
										{a.checks.map((c) => (
											<TipLi
												key={c.name}
												tip={c.detail}
												style={{
													color: c.ok ? "var(--mfw-ok)" : "var(--mfw-critical)",
												}}
											>
												<Glyph
													name={c.ok ? "check" : "cross"}
													label={c.ok ? "passed" : "failed"}
													className="mr-1 inline size-3 align-[-2px]"
												/>
												{c.name}
											</TipLi>
										))}
									</ul>
								) : (
									<span style={a.facts.verified ? undefined : faint}>
										{a.facts.verified || a.facts.verifyRan ? (
											<Glyph
												name={a.facts.verified ? "check" : "cross"}
												className="mr-1 inline size-3 align-[-2px]"
											/>
										) : null}
										{a.facts.verified
											? "passed"
											: a.facts.verifyRan
												? "failed"
												: "not run"}
									</span>
								)
							}
						</Row>
						<Row attempts={group.attempts} label="Scope">
							{(a) =>
								a.facts.scopeOutside > 0 ? (
									<span style={{ color: "var(--mfw-warn)" }}>
										{a.facts.scopeOutside} file
										{a.facts.scopeOutside === 1 ? "" : "s"} outside
									</span>
								) : (
									<span style={{ color: "var(--mfw-ok)" }}>
										<Glyph
											name="check"
											className="mr-1 inline size-3 align-[-2px]"
										/>
										inside
									</span>
								)
							}
						</Row>
						<Row attempts={group.attempts} label="Review">
							{(a) =>
								a.facts.review ? (
									<span
										style={{
											color:
												a.facts.review.status === "ok" &&
												a.facts.review.verdict === "merge"
													? "var(--mfw-ok)"
													: "var(--mfw-warn)",
										}}
									>
										{a.facts.review.verdict ?? a.facts.review.status}
									</span>
								) : (
									<span style={faint}>none</span>
								)
							}
						</Row>
						<Row attempts={group.attempts} label="Changes">
							{(a) => (
								<AttemptChanges project={project} group={group} attempt={a} />
							)}
						</Row>
						<Row attempts={group.attempts} label="Last message">
							{(a) =>
								a.note ? (
									<TipSpan
										className="break-words"
										tip={a.note.length > 240 ? a.note : undefined}
									>
										{a.note.length > 240 ? `${a.note.slice(0, 240)}…` : a.note}
									</TipSpan>
								) : (
									<span style={faint}>none</span>
								)
							}
						</Row>
						<tr>
							<th scope="row" />
							{group.attempts.map((a) => {
								const gate = selectGate(group, a);
								const picking =
									actions.selectWinner.pending &&
									actions.selectWinner.runId === a.runId;
								return (
									<td key={a.runId} className="px-2 pt-2 align-top">
										{a.winner ? (
											<span
												data-testid="winner"
												className="inline-flex items-center gap-1"
												style={{ color: "var(--mfw-warn)" }}
											>
												<Star aria-hidden className="size-3.5" /> Winner
											</span>
										) : (
											<div className="flex flex-col gap-1">
												<Button
													size="sm"
													data-testid={`select-${a.runId}`}
													disabled={
														!gate.enabled || actions.selectWinner.pending
													}
													title={
														gate.enabled
															? "Choose this attempt; it goes through the gates to the merge queue"
															: [gate.message, gate.fix]
																	.filter(Boolean)
																	.join(". ")
													}
													onClick={() => actions.selectWinner.send(a.runId)}
												>
													{picking ? "Selecting…" : "Select winner"}
												</Button>
												{!gate.enabled ? (
													<span
														data-testid={`blocked-${a.runId}`}
														style={{ ...faint, ...small }}
													>
														{gate.short ?? gate.message}
														{gate.fix ? ` — ${gate.fix}` : ""}
													</span>
												) : null}
											</div>
										)}
									</td>
								);
							})}
						</tr>
					</tbody>
				</table>
			</div>

			<AddAttemptDialog
				open={actions.addAttempt.open}
				onOpenChange={actions.addAttempt.setOpen}
				current={{ harness: null, model: null, hostId: null }}
				pending={actions.addAttempt.pending}
				error={actions.addAttempt.error}
				onSubmit={(pick) => actions.addAttempt.send(pick)}
			/>
			<StopAllDialog
				actions={actions.stopAll}
				title={`Stop all ${live.length} live attempt${live.length === 1 ? "" : "s"}?`}
			/>
		</div>
	);
}

function SelectionNote({
	group,
	decided,
}: {
	group: GroupData;
	decided: GroupData["selectedBy"];
}) {
	if (decided) {
		return (
			<p className="m-0" style={small} data-testid="selection-note">
				<strong>
					{decided.role === "human" ? "You selected" : "The brain selected"}
				</strong>{" "}
				{decided.runId ? (
					<span className="mfw-num">{decided.runId.slice(0, 8)}</span>
				) : null}
				{decided.reason ? <span style={muted}>: {decided.reason}</span> : null}
			</p>
		);
	}
	if (group.status !== "open") return null;
	return (
		<p
			className="m-0"
			style={{ ...small, ...muted }}
			data-testid="selection-note"
		>
			{group.selection === "first_verified"
				? "First verified wins: the first attempt to verify is selected automatically. You can still choose one below."
				: "The brain will select (selection: brain). Choosing here overrides it and is recorded as your decision."}
		</p>
	);
}

function AttemptHeader({
	attempt,
	project,
	onOpen,
}: {
	attempt: GroupAttempt;
	project: string;
	onOpen: () => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="flex items-center gap-1.5">
				{attempt.winner ? (
					<Star
						aria-hidden
						className="size-3.5"
						style={{ color: "var(--mfw-warn)" }}
					/>
				) : null}
				<AppLink
					to={href.board(project, { node: `run:${attempt.runId}` })}
					className="mfw-num truncate"
					onClick={(e) => {
						e.preventDefault();
						onOpen();
					}}
				>
					{attempt.label}
				</AppLink>
			</span>
			<span
				className="mfw-num"
				style={{ ...faint, fontSize: "var(--mfw-text-2xs)" }}
			>
				{attempt.runId.slice(0, 8)}
				{attempt.role ? ` · ${attempt.role}` : ""}
			</span>
		</div>
	);
}

function Row({
	label,
	attempts,
	children,
}: {
	label: string;
	attempts: readonly GroupAttempt[];
	children: (attempt: GroupAttempt) => ReactNode;
}) {
	return (
		<tr className="border-t" style={{ borderColor: "var(--mfw-border)" }}>
			<th
				scope="row"
				className="px-2 py-1.5 text-left align-top font-normal"
				style={muted}
			>
				{label}
			</th>
			{attempts.map((a) => (
				<td key={a.runId} className="min-w-0 px-2 py-1.5 align-top">
					{children(a)}
				</td>
			))}
		</tr>
	);
}

/**
 * The attempt's diff against base, read only: nothing is under review yet, so
 * there is no way to comment. Loaded when opened (the bundle is a git read).
 */
function AttemptChanges({
	project,
	group,
	attempt,
}: {
	project: string;
	group: GroupData;
	attempt: GroupAttempt;
}) {
	const [open, setOpen] = useState(false);
	const trpc = useTRPC();
	const bundle = useQuery({
		...trpc.review.bundle.queryOptions({
			project,
			taskId: group.taskId,
			runId: attempt.runId,
		}),
		enabled: open,
	});
	const stats = useMemo(
		() =>
			bundle.data
				? diffTotals(
						bundle.data.files.map((f) =>
							f.binary
								? { added: 0, removed: 0 }
								: countChanges(diffLines(f.oldText, f.newText)),
						),
					)
				: null,
		[bundle.data],
	);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="mfw-focus w-fit border-0 bg-transparent p-0 text-left"
				style={{ ...small, color: "var(--mfw-accent)" }}
			>
				{open ? "Hide diff" : "Show diff"}
				{stats ? (
					<span className="mfw-num" style={muted}>
						{" "}
						{"·"} {stats.files} file{stats.files === 1 ? "" : "s"} +
						{stats.added} {"−"}
						{stats.removed}
					</span>
				) : null}
			</button>
			{open && bundle.isPending ? <LoadingRows rows={2} /> : null}
			{open && bundle.isError ? (
				<span style={{ color: "var(--mfw-warn)" }}>
					Could not read the diff: {bundle.error.message}
				</span>
			) : null}
			{open && bundle.data ? (
				bundle.data.files.length === 0 ? (
					<span style={faint}>no changes against base</span>
				) : (
					<div className="flex min-w-0 flex-col gap-1">
						{bundle.data.files.map((file: ReviewFile) => (
							<details key={file.path}>
								<TipSummary
									className="mfw-num truncate"
									tip={file.path}
									clipped
								>
									{file.path}
								</TipSummary>
								<DiffView
									file={file}
									comments={[]}
									unified
									readOnly
									keys={false}
									onAdd={() => {}}
									onResolve={() => {}}
									onRemove={() => {}}
								/>
							</details>
						))}
						{bundle.data.truncated ? (
							<span style={faint}>more files than shown</span>
						) : null}
					</div>
				)
			) : null}
		</div>
	);
}
