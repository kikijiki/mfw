import { ErrorState } from "~/components/ErrorState";
import { LoadingRows } from "~/components/Loading";
import { Chip } from "~/components/Page";
import { Button } from "~/components/ui/button";

import {
	type AddState,
	type BoardTemplateInfo,
	DEFAULT_TEMPLATE_ID,
	type describeInspection,
	type SummaryLine,
} from "./addProject";
import { TemplateCards } from "./TemplateCards";

/** What the step needs of a query: kept structural so it never depends on the query client's types. */
interface QueryState {
	isLoading: boolean;
	error: unknown;
	refetch: () => unknown;
}

const TONE_TOKEN = {
	neutral: "--mfw-border",
	success: "--mfw-ok",
	warning: "--mfw-warn",
	error: "--mfw-critical",
} as const;

function Option({
	checked,
	title,
	detail,
	onSelect,
	action,
}: {
	checked: boolean;
	title: string;
	detail: string;
	onSelect: () => void;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div
			className="flex items-stretch gap-2 border"
			style={{
				borderRadius: "var(--mfw-radius-sm)",
				borderColor: checked ? "var(--mfw-accent)" : "var(--mfw-border)",
				background: checked ? "var(--mfw-accent-subtle)" : "transparent",
			}}
		>
			<button
				type="button"
				aria-pressed={checked}
				className="mfw-focus flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center px-2 py-1 text-left"
				onClick={onSelect}
			>
				<span className="font-medium">{title}</span>
				<span
					className="mfw-num max-w-full min-w-0 [overflow-wrap:anywhere] text-left"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{detail}
				</span>
			</button>
			{action ? (
				<Button
					type="button"
					variant="ghost"
					className="self-center max-md:min-h-11"
					onClick={action.onClick}
				>
					{action.label}
				</Button>
			) : null}
		</div>
	);
}

/**
 * Step two of adding a project: where the board lives, what is found there
 * (live `inspectBoardFolder`), the template when there is no board, and the
 * plain-language list of what Add will do. All state lives in the parent.
 */
export function BoardStep({
	state,
	onChange,
	folderPath,
	onPickFolder,
	inspection,
	view,
	templates,
	summary,
	error,
}: {
	state: AddState;
	onChange: (state: AddState) => void;
	/** The board folder when it is not the repository (shown on the option). */
	folderPath: string | null;
	onPickFolder: () => void;
	/** Null when the folder is to be created (nothing to query). */
	inspection: QueryState | null;
	view: ReturnType<typeof describeInspection>;
	templates: QueryState & { data: BoardTemplateInfo[] | undefined };
	summary: SummaryLine[];
	/** The last Add failure, shown where the action is. */
	error: string | null;
}) {
	const separate = state.board.kind === "folder";
	const token = TONE_TOKEN[view.tone];
	const chosenTemplate = state.template ?? DEFAULT_TEMPLATE_ID;

	return (
		<div className="flex flex-col gap-3">
			<fieldset
				aria-label="Where does the board live?"
				className="flex flex-col gap-2"
			>
				<Option
					checked={!separate}
					title="Inside this repository (default)"
					detail={state.repo ?? ""}
					onSelect={() => onChange({ ...state, board: { kind: "repo" } })}
				/>
				<Option
					checked={separate}
					title="Another folder…"
					detail={
						separate && folderPath
							? folderPath
							: "A folder of its own, git or not, for tasks and ADRs"
					}
					onSelect={() => {
						if (separate) return;
						onPickFolder();
					}}
					action={
						separate ? { label: "Change", onClick: onPickFolder } : undefined
					}
				/>
			</fieldset>

			<section
				aria-label="What is in the board folder"
				aria-live="polite"
				className="flex flex-col gap-2 border p-2"
				style={{
					borderRadius: "var(--mfw-radius-sm)",
					borderColor: `var(${token})`,
				}}
			>
				{inspection?.isLoading ? (
					<LoadingRows rows={2} />
				) : inspection?.error ? (
					<ErrorState
						title="Could not look at this folder"
						error={inspection.error}
						onRetry={() => void inspection.refetch()}
					/>
				) : (
					<>
						<p className="font-medium">{view.title}</p>
						{view.detail ? (
							<p
								style={{
									color:
										view.tone === "error"
											? "var(--mfw-critical)"
											: "var(--mfw-fg-muted)",
									fontSize: "var(--mfw-text-xs)",
									whiteSpace: "pre-wrap",
								}}
								role={view.tone === "error" ? "alert" : undefined}
							>
								{view.detail}
							</p>
						) : null}
						{view.statuses.length > 0 ? (
							<ul className="flex flex-wrap gap-1" aria-label="Statuses">
								{view.statuses.map((status) => (
									<li key={status.name}>
										<Chip
											title={
												status.role ? `Dispatches as ${status.role}` : undefined
											}
										>
											{status.name} {status.count}
											{status.role && status.role !== status.name
												? ` → ${status.role}`
												: ""}
										</Chip>
									</li>
								))}
							</ul>
						) : null}
					</>
				)}
			</section>

			{view.needsTemplate ? (
				<section aria-label="Board template" className="flex flex-col gap-2">
					<p style={{ fontSize: "var(--mfw-text-xs)" }}>
						Pick the columns for the new board:
					</p>
					{templates.isLoading ? (
						<LoadingRows rows={3} />
					) : templates.error ? (
						<ErrorState
							title="Could not load the board templates"
							error={templates.error}
							onRetry={() => void templates.refetch()}
						/>
					) : (
						<TemplateCards
							templates={templates.data ?? []}
							value={chosenTemplate}
							onChange={(id) => onChange({ ...state, template: id })}
						/>
					)}
				</section>
			) : null}

			<section aria-label="What will happen">
				<h3 className="font-medium">When you press Add</h3>
				<dl
					className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
					style={{ fontSize: "var(--mfw-text-xs)" }}
				>
					{summary.map((line) => (
						<div key={line.label} className="contents">
							<dt style={{ color: "var(--mfw-fg-muted)" }}>{line.label}</dt>
							<dd className="mfw-num min-w-0 break-words">{line.value}</dd>
						</div>
					))}
				</dl>
			</section>

			{error ? (
				<p
					role="alert"
					className="border p-2"
					style={{
						borderColor: "var(--mfw-critical)",
						borderRadius: "var(--mfw-radius-sm)",
						color: "var(--mfw-critical)",
						fontSize: "var(--mfw-text-xs)",
						whiteSpace: "pre-wrap",
					}}
				>
					{error}
				</p>
			) : null}
		</div>
	);
}
