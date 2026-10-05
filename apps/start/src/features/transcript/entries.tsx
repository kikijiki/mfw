import type { AgentEvent } from "@mfw/daemon/agents/events";
import {
	Bot,
	Brain,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleCheck,
	CircleX,
	FileCheck,
	FileText,
	Flag,
	GitCompareArrows,
	Globe,
	LoaderCircle,
	type LucideIcon,
	MessageSquare,
	OctagonAlert,
	Pencil,
	PlugZap,
	Search,
	ShieldCheck,
	Terminal,
	Timer,
	User,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";

import { cn } from "~/lib/utils";
import { Chip } from "../../components/Page";

/**
 * Transcript entries as typed blocks. Turns the server-parsed `AgentEvent`
 * list into display items once (pairing each `tool_call` with its
 * `tool_result`) and renders them.
 */

type TranscriptPosition = {
	/** First event: stable card identity and ordering in the full transcript. */
	seq: number;
	ts: string;
	/** Later events folded into this card, for deep links and tail recency. */
	seqs?: number[];
	latestSeq?: number;
	updatedAt?: string;
};

export type TranscriptItem = TranscriptPosition &
	(
		| {
				kind: "message";
				role: "assistant" | "user";
				text: string;
		  }
		| { kind: "thinking"; text: string }
		| {
				kind: "tool";
				id: string;
				name: string;
				input: unknown;
				result: { ok: boolean; output: string } | null;
				progress: string;
		  }
		| {
				kind: "plan";
				explanation?: string;
				steps: { step: string; status: string }[];
		  }
		| { kind: "diff"; turnId: string; diff: string }
		| {
				kind: "file_change";
				id: string;
				phase: string;
				status?: string;
				changes: { path: string; kind: string; diff?: string }[];
		  }
		| {
				kind: "mcp_activity";
				id: string;
				server?: string;
				tool: string;
				phase: string;
				input?: unknown;
				output?: unknown;
				ok?: boolean;
		  }
		| {
				kind: "approval";
				requestId: string;
				approvalKind: string;
				status: string;
				summary: string;
				details?: unknown;
		  }
		| {
				kind: "notice";
				category: string;
				message: string;
				metadata?: unknown;
		  }
		| { kind: "error"; message: string; fatal: boolean }
		| {
				kind: "rate_limit";
				status: string;
				limited: boolean;
				resetsAt: number | null;
				utilization?: number | null;
		  }
		| {
				kind: "done";
				reason: string;
				resultText?: string;
		  }
	);

function recordFold(target: TranscriptItem, seq: number, ts: string) {
	target.seqs ??= [target.seq];
	target.seqs.push(seq);
	target.latestSeq = seq;
	target.updatedAt = ts;
}

/**
 * Fold events into display items. `usage` and `hello` carry no line of their
 * own: they feed the header totals and the steer affordance respectively.
 */
export function buildItems(entries: AgentEvent[]): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const toolIndex = new Map<string, number>();
	const planIndex = new Map<string, number>();
	const diffIndex = new Map<string, number>();
	const fileChangeIndex = new Map<string, number>();
	const mcpIndex = new Map<string, number>();
	const approvalIndex = new Map<string, number>();
	let rateLimitIndex: number | undefined;
	const richActivityIds = new Set<string>();
	let activeTurn = "unscoped";
	for (const e of entries) {
		switch (e.type) {
			case "message":
				items.push({
					kind: "message",
					seq: e.seq,
					ts: e.ts,
					role: e.role,
					text: e.text,
				});
				break;
			case "thinking":
				// Skip empty blocks: older runs contain signature-only thinking events.
				if (e.text.trim())
					items.push({ kind: "thinking", seq: e.seq, ts: e.ts, text: e.text });
				break;
			case "tool_call":
				toolIndex.set(e.id, items.length);
				items.push({
					kind: "tool",
					seq: e.seq,
					ts: e.ts,
					id: e.id,
					name: e.name,
					input: e.input,
					result: null,
					progress: "",
				});
				break;
			case "tool_result": {
				const at = toolIndex.get(e.id);
				const target = at === undefined ? undefined : items[at];
				if (target && target.kind === "tool") {
					target.result = { ok: e.ok, output: e.output };
					recordFold(target, e.seq, e.ts);
				} else {
					// Orphan result (its call is outside this window): keep it visible.
					items.push({
						kind: "tool",
						seq: e.seq,
						ts: e.ts,
						id: e.id,
						name: "result",
						input: null,
						result: { ok: e.ok, output: e.output },
						progress: "",
					});
				}
				break;
			}
			case "tool_progress": {
				const at = toolIndex.get(e.id);
				const target = at === undefined ? undefined : items[at];
				if (target && target.kind === "tool") {
					target.progress += e.output;
					recordFold(target, e.seq, e.ts);
				} else {
					toolIndex.set(e.id, items.length);
					items.push({
						kind: "tool",
						seq: e.seq,
						ts: e.ts,
						id: e.id,
						name: "progress",
						input: null,
						result: null,
						progress: e.output,
					});
				}
				break;
			}
			case "session": {
				// No row: lifecycle is in the run header; this only sets the plan correlation scope.
				activeTurn = `${e.provider}:${e.sessionId}:${e.ordinal}`;
				break;
			}
			case "plan": {
				const at = planIndex.get(activeTurn);
				const target = at === undefined ? undefined : items[at];
				if (target?.kind === "plan") {
					target.explanation = e.explanation ?? target.explanation;
					target.steps = e.steps;
					recordFold(target, e.seq, e.ts);
				} else {
					planIndex.set(activeTurn, items.length);
					items.push({
						kind: "plan",
						seq: e.seq,
						ts: e.ts,
						explanation: e.explanation,
						steps: e.steps,
					});
				}
				break;
			}
			case "diff": {
				const at = diffIndex.get(e.turnId);
				const target = at === undefined ? undefined : items[at];
				if (target?.kind === "diff") {
					target.diff = e.diff;
					recordFold(target, e.seq, e.ts);
				} else {
					diffIndex.set(e.turnId, items.length);
					items.push({
						kind: "diff",
						seq: e.seq,
						ts: e.ts,
						turnId: e.turnId,
						diff: e.diff,
					});
				}
				break;
			}
			case "file_change": {
				richActivityIds.add(e.id);
				const at = fileChangeIndex.get(e.id);
				const target = at === undefined ? undefined : items[at];
				if (target?.kind === "file_change") {
					target.phase = e.phase;
					target.status = e.status ?? target.status;
					if (e.changes.length > 0) target.changes = e.changes;
					recordFold(target, e.seq, e.ts);
				} else {
					fileChangeIndex.set(e.id, items.length);
					items.push({
						kind: "file_change",
						seq: e.seq,
						ts: e.ts,
						id: e.id,
						phase: e.phase,
						status: e.status,
						changes: e.changes,
					});
				}
				break;
			}
			case "mcp_activity": {
				richActivityIds.add(e.id);
				const at = mcpIndex.get(e.id);
				const target = at === undefined ? undefined : items[at];
				if (target?.kind === "mcp_activity") {
					target.phase = e.phase;
					target.server = e.server ?? target.server;
					target.tool = e.tool || target.tool;
					target.input = e.input ?? target.input;
					target.output = e.output ?? target.output;
					target.ok = e.ok ?? target.ok;
					recordFold(target, e.seq, e.ts);
				} else {
					mcpIndex.set(e.id, items.length);
					items.push({
						kind: "mcp_activity",
						seq: e.seq,
						ts: e.ts,
						id: e.id,
						server: e.server,
						tool: e.tool,
						phase: e.phase,
						input: e.input,
						output: e.output,
						ok: e.ok,
					});
				}
				break;
			}
			case "approval": {
				const at = approvalIndex.get(e.requestId);
				const target = at === undefined ? undefined : items[at];
				if (target?.kind === "approval") {
					target.status = e.status;
					target.approvalKind = e.kind;
					if (!/^approval resolved\.?$/i.test(e.summary.trim()))
						target.summary = e.summary || target.summary;
					target.details = e.details ?? target.details;
					recordFold(target, e.seq, e.ts);
				} else {
					approvalIndex.set(e.requestId, items.length);
					items.push({
						kind: "approval",
						seq: e.seq,
						ts: e.ts,
						requestId: e.requestId,
						approvalKind: e.kind,
						status: e.status,
						summary: e.summary,
						details: e.details,
					});
				}
				break;
			}
			case "notice":
				items.push({
					kind: "notice",
					seq: e.seq,
					ts: e.ts,
					category: e.category,
					message: e.message,
					metadata: e.metadata,
				});
				break;
			case "error":
				items.push({
					kind: "error",
					seq: e.seq,
					ts: e.ts,
					message: e.message,
					fatal: e.fatal,
				});
				break;
			case "rate_limit":
				if (rateLimitIndex === undefined) {
					rateLimitIndex = items.length;
					items.push({
						kind: "rate_limit",
						seq: e.seq,
						ts: e.ts,
						status: e.status,
						limited: e.limited,
						resetsAt: e.resetsAt,
						utilization: e.utilization,
					});
				} else {
					const target = items[rateLimitIndex];
					if (target?.kind === "rate_limit") {
						target.status = e.status;
						target.limited = e.limited;
						target.resetsAt = e.resetsAt;
						target.utilization = e.utilization;
						recordFold(target, e.seq, e.ts);
					}
				}
				break;
			case "done":
				items.push({
					kind: "done",
					seq: e.seq,
					ts: e.ts,
					reason: e.reason,
					resultText: e.resultText,
				});
				break;
			default:
				break;
		}
	}
	// App-server streams can describe one operation twice (generic tool and
	// richer file/MCP lifecycle); filter after the fold to handle either order.
	return items.filter(
		(item) => item.kind !== "tool" || !richActivityIds.has(item.id),
	);
}

/** Everything searchable in an item, as one lowercase haystack. */
export function itemText(item: TranscriptItem): string {
	switch (item.kind) {
		case "message":
		case "thinking":
			return item.text;
		case "tool":
			return `${item.name} ${stringifyInput(item.input)} ${item.progress} ${item.result?.output ?? ""}`;
		case "plan":
			return `${item.explanation ?? ""} ${item.steps.map((step) => `${step.status} ${step.step}`).join(" ")}`;
		case "diff":
			return `${item.turnId} ${item.diff}`;
		case "file_change":
			return `${item.id} ${item.phase} ${item.status ?? ""} ${item.changes.map((change) => `${change.kind} ${change.path} ${change.diff ?? ""}`).join(" ")}`;
		case "mcp_activity":
			return `${item.id} ${item.server ?? ""} ${item.tool} ${item.phase} ${stringifyInput(item.input)} ${stringifyInput(item.output)}`;
		case "approval":
			return `${item.requestId} ${item.approvalKind} ${item.status} ${item.summary} ${stringifyInput(item.details)}`;
		case "notice":
			return `${item.category} ${item.message} ${stringifyInput(item.metadata)}`;
		case "error":
			return item.message;
		case "rate_limit":
			return `${item.limited ? "rate limited" : "quota update"} ${item.status} ${item.utilization == null ? "" : `${Math.round(item.utilization * 100)}% used`}`;
		case "done":
			return item.reason;
	}
}

/** Items an operator jumps between with `e`: failures, not just `error`s. */
export function isFailure(item: TranscriptItem): boolean {
	return (
		item.kind === "error" ||
		(item.kind === "tool" && item.result?.ok === false) ||
		(item.kind === "mcp_activity" && item.ok === false) ||
		(item.kind === "file_change" && item.status === "failed") ||
		(item.kind === "done" && item.reason !== "complete")
	);
}

const TOOL_ICON: Record<string, LucideIcon> = {
	bash: Terminal,
	read: FileText,
	write: Pencil,
	edit: Pencil,
	multiedit: Pencil,
	notebookedit: Pencil,
	glob: Search,
	grep: Search,
	task: Bot,
	webfetch: Globe,
	websearch: Globe,
};

function humanStatus(status: string): string {
	return status
		.replaceAll("_", " ")
		.replace(/^./, (first) => first.toUpperCase());
}

/** The one argument that says what a call actually did. */
function primaryArg(name: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const o = input as Record<string, unknown>;
	const pick = (...keys: string[]) => {
		for (const k of keys) {
			const v = o[k];
			if (typeof v === "string" && v) return v;
		}
		return "";
	};
	switch (name.toLowerCase()) {
		case "bash":
			return pick("command");
		case "read":
		case "write":
		case "edit":
		case "multiedit":
			return pick("file_path", "path");
		case "task":
			return pick("description", "prompt");
		case "grep":
		case "glob":
			return pick("pattern", "query");
		case "webfetch":
		case "websearch":
			return pick("url", "query");
		default:
			return pick("file_path", "path", "command", "description", "query");
	}
}

function stringifyInput(input: unknown): string {
	if (input == null) return "";
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

/** Truncate long tool output; the full text is one click away. */
const OUTPUT_LINES = 30;

export interface TranscriptEntryProps {
	item: TranscriptItem;
	expanded: boolean;
	onToggle: () => void;
	/** Lowercased search needle; matches are highlighted. */
	query?: string;
	/** `tail` renders one dense line per item (the NOW card). */
	density?: "full" | "tail";
	focused?: boolean;
	flash?: boolean;
	onApproval?: (
		requestId: string,
		decision: "accept" | "acceptForSession" | "decline" | "cancel",
	) => void;
	approvalPending?: boolean;
}

export function TranscriptEntry({
	item,
	expanded,
	onToggle,
	query,
	density = "full",
	focused = false,
	flash = false,
	onApproval,
	approvalPending = false,
}: TranscriptEntryProps) {
	const tail = density === "tail";
	const rowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (focused) rowRef.current?.focus({ preventScroll: true });
	}, [focused]);
	return (
		<div
			ref={rowRef}
			data-seq={item.seq}
			tabIndex={focused ? 0 : -1}
			aria-current={focused ? "true" : undefined}
			className={cn(
				"min-w-0 border-l-2 px-2",
				tail ? "py-0.5" : "py-1",
				focused && "mfw-focus",
			)}
			style={{
				borderLeftColor: focused
					? "var(--mfw-accent)"
					: flash
						? "var(--mfw-warn)"
						: "transparent",
				background: flash
					? "color-mix(in oklch, var(--mfw-warn) 12%, transparent)"
					: undefined,
				fontSize: tail ? "var(--mfw-text-xs)" : "var(--mfw-font-data)",
			}}
		>
			{/* Timestamp gutter (fixed width, tabular figures; full timestamp in tooltip). Omitted in `tail` density. */}
			{tail ? (
				<Body
					item={item}
					expanded={expanded}
					onToggle={onToggle}
					query={query}
					tail={tail}
					onApproval={onApproval}
					approvalPending={approvalPending}
				/>
			) : (
				<div className="flex min-w-0 items-start gap-2">
					<time
						dateTime={item.ts}
						title={new Date(item.ts).toLocaleString()}
						className="mfw-num shrink-0 select-none tabular-nums"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
							lineHeight: "var(--mfw-leading-data)",
						}}
					>
						{clock(item.ts)}
					</time>
					<div className="min-w-0 flex-1">
						<Body
							item={item}
							expanded={expanded}
							onToggle={onToggle}
							query={query}
							tail={tail}
							onApproval={onApproval}
							approvalPending={approvalPending}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function Body({
	item,
	expanded,
	onToggle,
	query,
	tail,
	onApproval,
	approvalPending,
}: {
	item: TranscriptItem;
	expanded: boolean;
	onToggle: () => void;
	query?: string;
	tail: boolean;
	onApproval?: TranscriptEntryProps["onApproval"];
	approvalPending: boolean;
}) {
	switch (item.kind) {
		case "message":
			return (
				<MessageBlock
					item={item}
					query={query}
					tail={tail}
					expanded={expanded}
					onToggle={onToggle}
				/>
			);
		case "thinking":
			return (
				<Disclosure
					icon={Brain}
					tone="var(--mfw-fg-faint)"
					open={expanded}
					onToggle={onToggle}
					summary={
						<span style={{ color: "var(--mfw-fg-faint)" }}>
							thinking ({wordCount(item.text)} words)
						</span>
					}
				>
					<pre
						className="mt-1 whitespace-pre-wrap italic"
						style={{
							color: "var(--mfw-fg-faint)",
							fontFamily: "var(--mfw-font-mono)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						<Highlight text={item.text} query={query} />
					</pre>
				</Disclosure>
			);
		case "tool":
			return (
				<ToolBlock
					item={item}
					expanded={expanded}
					onToggle={onToggle}
					query={query}
					tail={tail}
				/>
			);
		case "plan": {
			const complete = item.steps.filter(
				(step) => step.status === "completed",
			).length;
			const active = item.steps.some((step) => step.status === "in_progress");
			const PlanIcon =
				item.steps.length > 0 && complete === item.steps.length
					? CircleCheck
					: active
						? LoaderCircle
						: Circle;
			return (
				<Disclosure
					icon={PlanIcon}
					tone={
						complete === item.steps.length && item.steps.length > 0
							? "var(--mfw-ok)"
							: "var(--mfw-accent)"
					}
					open={expanded}
					onToggle={onToggle}
					summary={
						<span className="flex min-w-0 items-center gap-2">
							<span className="font-medium">Plan</span>
							<span style={{ color: "var(--mfw-fg-muted)" }}>
								{complete} of {item.steps.length} complete
							</span>
						</span>
					}
				>
					<div className="mt-1 flex flex-col gap-1 pl-1">
						{item.explanation ? (
							<div style={{ color: "var(--mfw-fg-muted)" }}>
								<Highlight text={item.explanation} query={query} />
							</div>
						) : null}
						{item.steps.map((step) => (
							<div key={`${step.status}-${step.step}`} className="flex gap-2">
								<span aria-hidden>
									{step.status === "completed"
										? "✓"
										: step.status === "in_progress"
											? "●"
											: "○"}
								</span>
								<span>
									<span className="sr-only">{humanStatus(step.status)}: </span>
									<Highlight text={step.step} query={query} />
								</span>
							</div>
						))}
					</div>
				</Disclosure>
			);
		}
		case "diff":
			return (
				<RichBlock
					icon={GitCompareArrows}
					title="Turn diff"
					detail={item.diff}
					code
					expanded={expanded}
					onToggle={onToggle}
					query={query}
					tail={tail}
				/>
			);
		case "file_change": {
			const finished = item.phase === "completed";
			return (
				<RichBlock
					icon={finished ? FileCheck : Pencil}
					tone={finished ? "var(--mfw-ok)" : "var(--mfw-accent)"}
					title={`${item.changes.length} ${item.changes.length === 1 ? "file" : "files"} · ${finished ? "Changed" : "Changing"}${item.status ? ` · ${humanStatus(item.status)}` : ""}`}
					detail={item.changes
						.map(
							(change) =>
								`${change.kind} ${change.path}${change.diff ? `\n${change.diff}` : ""}`,
						)
						.join("\n")}
					expanded={expanded}
					onToggle={onToggle}
					query={query}
					tail={tail}
					code
				/>
			);
		}
		case "mcp_activity": {
			const complete = item.phase === "completed";
			const failed = complete && item.ok === false;
			return (
				<RichBlock
					icon={failed ? CircleX : complete ? CircleCheck : PlugZap}
					tone={
						failed
							? "var(--mfw-critical)"
							: complete
								? "var(--mfw-ok)"
								: "var(--mfw-accent)"
					}
					title={`${item.server ? `${item.server} · ` : ""}${item.tool} · ${failed ? "Failed" : complete ? "Completed" : "Running"}`}
					detail={`${item.input === undefined ? "" : `input\n${stringifyInput(item.input)}`}${item.output === undefined ? "" : `${item.input === undefined ? "" : "\n"}output\n${stringifyInput(item.output)}`}`}
					expanded={expanded}
					onToggle={onToggle}
					query={query}
					tail={tail}
					code
				/>
			);
		}
		case "approval": {
			const pending = item.status === "pending";
			const ApprovalIcon =
				item.status === "accepted"
					? ShieldCheck
					: pending
						? OctagonAlert
						: CircleX;
			return (
				<div
					role={pending ? "status" : undefined}
					aria-live={pending ? "polite" : undefined}
					className="flex flex-col gap-1 px-1 py-1"
					style={{
						background: pending
							? "color-mix(in oklch, var(--mfw-warn) 10%, transparent)"
							: undefined,
						borderRadius: "var(--mfw-radius-sm)",
					}}
				>
					<RichBlock
						icon={ApprovalIcon}
						tone={
							item.status === "accepted"
								? "var(--mfw-ok)"
								: pending
									? "var(--mfw-warn)"
									: "var(--mfw-critical)"
						}
						title={`${humanStatus(item.status)} ${item.approvalKind.replace("_", " ")} approval`}
						detail={`${item.summary}${item.details === undefined ? "" : `\n${stringifyInput(item.details)}`}`}
						expanded={expanded}
						onToggle={onToggle}
						query={query}
						tail={tail}
					/>
					{item.status === "pending" && onApproval && !tail ? (
						<div className="flex flex-wrap gap-1 pl-5">
							<ApprovalButton
								label="Accept"
								requestId={item.requestId}
								disabled={approvalPending}
								onClick={() => onApproval(item.requestId, "accept")}
							/>
							<ApprovalButton
								label="For session"
								requestId={item.requestId}
								disabled={approvalPending}
								onClick={() => onApproval(item.requestId, "acceptForSession")}
							/>
							<ApprovalButton
								label="Decline"
								requestId={item.requestId}
								disabled={approvalPending}
								onClick={() => onApproval(item.requestId, "decline")}
							/>
						</div>
					) : null}
				</div>
			);
		}
		case "notice":
			return (
				<RichBlock
					icon={OctagonAlert}
					title={`${item.category.replace("_", " ")} notice`}
					detail={`${item.message}${item.metadata === undefined ? "" : `\n${stringifyInput(item.metadata)}`}`}
					expanded={expanded}
					onToggle={onToggle}
					query={query}
					tail={tail}
				/>
			);
		case "error":
			return (
				<div
					className="flex items-start gap-2 px-1 py-1"
					style={{
						color: "var(--mfw-critical)",
						background:
							"color-mix(in oklch, var(--mfw-critical) 10%, transparent)",
						borderRadius: "var(--mfw-radius-sm)",
					}}
				>
					<OctagonAlert aria-hidden className="mt-px size-3.5 shrink-0" />
					<span className="min-w-0 break-words whitespace-pre-wrap">
						<Highlight text={item.message} query={query} />
						{item.fatal ? " (fatal)" : ""}
					</span>
				</div>
			);
		case "rate_limit":
			return (
				<div
					className="flex items-center gap-2"
					style={{
						color: item.limited ? "var(--mfw-warn)" : "var(--mfw-fg-muted)",
					}}
				>
					<Timer aria-hidden className="size-3.5 shrink-0" />
					<span>
						{item.limited ? "Rate limited" : "Quota update"}: {item.status}
						{item.utilization == null
							? ""
							: ` · ${Math.round(item.utilization * 100)}% used`}
						{item.resetsAt
							? ` · resets ${new Date(item.resetsAt).toLocaleTimeString()}`
							: ""}
					</span>
				</div>
			);
		case "done":
			return (
				<div
					className="my-1 flex items-start gap-2 border-t border-b py-1"
					style={{
						borderColor: "var(--mfw-border)",
						color:
							item.reason === "complete"
								? "var(--mfw-ok)"
								: "var(--mfw-critical)",
					}}
				>
					<Flag aria-hidden className="mt-px size-3.5 shrink-0" />
					<div className="min-w-0">done: {item.reason}</div>
				</div>
			);
	}
}

function MessageBlock({
	item,
	query,
	tail,
	expanded,
	onToggle,
}: {
	item: Extract<TranscriptItem, { kind: "message" }>;
	query?: string;
	tail: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	const Icon = item.role === "assistant" ? MessageSquare : User;
	const long = item.text.length > 1200;
	const shown = long && !expanded ? `${item.text.slice(0, 1200)}…` : item.text;
	return (
		<div className="flex min-w-0 items-start gap-2">
			<Icon
				aria-hidden
				className="mt-0.5 size-3.5 shrink-0"
				style={{
					color:
						item.role === "assistant"
							? "var(--mfw-fg-faint)"
							: "var(--mfw-accent)",
				}}
			/>
			<div className="min-w-0 flex-1">
				<div
					className={cn(
						"break-words whitespace-pre-wrap",
						tail && "truncate whitespace-nowrap",
					)}
					style={{ lineHeight: "var(--mfw-leading-prose)" }}
				>
					<Highlight text={tail ? firstLine(item.text) : shown} query={query} />
				</div>
				{long && !tail ? (
					<button
						type="button"
						className="mfw-focus mt-0.5 underline underline-offset-2"
						style={{
							color: "var(--mfw-accent)",
							fontSize: "var(--mfw-text-xs)",
						}}
						onClick={onToggle}
					>
						{expanded ? "show less" : "show all"}
					</button>
				) : null}
			</div>
		</div>
	);
}

function RichBlock({
	icon,
	tone = "var(--mfw-fg-faint)",
	title,
	detail,
	expanded,
	onToggle,
	query,
	tail,
	code = false,
}: {
	icon: LucideIcon;
	tone?: string;
	title: string;
	detail: string;
	expanded: boolean;
	onToggle: () => void;
	query?: string;
	tail: boolean;
	code?: boolean;
}) {
	if (tail)
		return (
			<div className="flex min-w-0 items-center gap-2">
				{(() => {
					const Icon = icon;
					return (
						<Icon
							aria-hidden
							className="size-3.5 shrink-0"
							style={{ color: tone }}
						/>
					);
				})()}
				<span className="truncate">
					{title}
					{detail ? ` · ${firstLine(detail)}` : ""}
				</span>
			</div>
		);
	return (
		<Disclosure
			icon={icon}
			tone={tone}
			open={expanded}
			onToggle={onToggle}
			summary={
				<span className="truncate">
					{title}
					{detail ? ` · ${firstLine(detail)}` : ""}
				</span>
			}
		>
			{code ? (
				<CodeBlock label={title} text={detail} query={query} clamp />
			) : (
				<div
					className="mt-1 whitespace-pre-wrap pl-5"
					style={{ color: "var(--mfw-fg-muted)" }}
				>
					<Highlight text={detail} query={query} />
				</div>
			)}
		</Disclosure>
	);
}

function ApprovalButton({
	label,
	requestId,
	disabled,
	onClick,
}: {
	label: string;
	requestId: string;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={`${label} approval ${requestId}`}
			disabled={disabled}
			onClick={onClick}
			className="mfw-focus min-h-6 rounded border px-2 py-1 disabled:opacity-50"
			style={{
				borderColor: "var(--mfw-border)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			{label}
		</button>
	);
}

function ToolBlock({
	item,
	expanded,
	onToggle,
	query,
	tail,
}: {
	item: Extract<TranscriptItem, { kind: "tool" }>;
	expanded: boolean;
	onToggle: () => void;
	query?: string;
	tail: boolean;
}) {
	const Icon = TOOL_ICON[item.name.toLowerCase()] ?? Terminal;
	const arg = primaryArg(item.name, item.input);
	const ok = item.result?.ok;
	const summary = (
		<span className="flex min-w-0 flex-1 items-center gap-2">
			<span className="shrink-0 font-medium">{item.name}</span>
			<span
				className="mfw-num min-w-0 flex-1 truncate"
				style={{ color: "var(--mfw-fg-muted)" }}
				title={arg}
			>
				<Highlight text={firstLine(arg)} query={query} />
			</span>
			{item.result ? (
				ok ? (
					<CircleCheck
						aria-label="succeeded"
						className="size-3.5 shrink-0"
						style={{ color: "var(--mfw-ok)" }}
					/>
				) : (
					<CircleX
						aria-label="failed"
						className="size-3.5 shrink-0"
						style={{ color: "var(--mfw-critical)" }}
					/>
				)
			) : (
				<span
					className="mfw-pulse shrink-0"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					running
				</span>
			)}
		</span>
	);

	if (tail) {
		return (
			<div className="flex min-w-0 items-center gap-2">
				<Icon
					aria-hidden
					className="size-3.5 shrink-0"
					style={{ color: "var(--mfw-fg-faint)" }}
				/>
				{summary}
			</div>
		);
	}

	return (
		<Disclosure
			icon={Icon}
			tone="var(--mfw-fg-faint)"
			open={expanded}
			onToggle={onToggle}
			summary={summary}
		>
			<div className="mt-1 flex flex-col gap-1">
				<CodeBlock
					label="input"
					text={stringifyInput(item.input)}
					query={query}
				/>
				{item.result ? (
					<CodeBlock
						label={item.result.ok ? "output" : "output (failed)"}
						text={item.result.output}
						query={query}
						tone={item.result.ok ? undefined : "var(--mfw-critical)"}
						clamp
					/>
				) : null}
				{item.progress ? (
					<CodeBlock
						label="live output"
						text={item.progress}
						query={query}
						clamp
					/>
				) : null}
			</div>
		</Disclosure>
	);
}

function Disclosure({
	icon: Icon,
	tone,
	open,
	onToggle,
	summary,
	children,
}: {
	icon: LucideIcon;
	tone: string;
	open: boolean;
	onToggle: () => void;
	summary: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="mfw-focus flex w-full min-w-0 items-center gap-1.5 text-left"
			>
				{open ? (
					<ChevronDown
						aria-hidden
						className="size-3 shrink-0"
						style={{ color: tone }}
					/>
				) : (
					<ChevronRight
						aria-hidden
						className="size-3 shrink-0"
						style={{ color: tone }}
					/>
				)}
				<Icon
					aria-hidden
					className="size-3.5 shrink-0"
					style={{ color: tone }}
				/>
				{summary}
			</button>
			{open ? children : null}
		</div>
	);
}

function CodeBlock({
	label,
	text,
	query,
	tone,
	clamp = false,
}: {
	label: string;
	text: string;
	query?: string;
	tone?: string;
	clamp?: boolean;
}) {
	const lines = text.split("\n");
	const truncated = clamp && lines.length > OUTPUT_LINES;
	const shown = truncated ? lines.slice(0, OUTPUT_LINES).join("\n") : text;
	return (
		<div className="min-w-0">
			<div
				className="uppercase"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
					letterSpacing: "0.06em",
				}}
			>
				{label}
			</div>
			<pre
				className="mfw-num max-h-100 overflow-auto p-1.5 whitespace-pre-wrap"
				style={{
					background: "var(--mfw-bg-inset)",
					borderRadius: "var(--mfw-radius-sm)",
					color: tone ?? "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<Highlight text={shown} query={query} />
				{truncated ? `\n… ${lines.length - OUTPUT_LINES} more lines` : ""}
			</pre>
		</div>
	);
}

function firstLine(text: string): string {
	const i = text.indexOf("\n");
	return i === -1 ? text : text.slice(0, i);
}

/** `HH:MM:SS` in the viewer's timezone. */
function clock(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "--:--:--";
	return d.toLocaleTimeString(undefined, { hour12: false });
}

function wordCount(text: string): number {
	return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Case-insensitive match highlighting; no query returns the text untouched. */
export function Highlight({ text, query }: { text: string; query?: string }) {
	const parts = useMemo(() => {
		if (!query) return null;
		const needle = query.toLowerCase();
		const hay = text.toLowerCase();
		const out: { text: string; hit: boolean }[] = [];
		let at = 0;
		for (;;) {
			const found = hay.indexOf(needle, at);
			if (found === -1) {
				out.push({ text: text.slice(at), hit: false });
				break;
			}
			if (found > at) out.push({ text: text.slice(at, found), hit: false });
			out.push({ text: text.slice(found, found + needle.length), hit: true });
			at = found + needle.length;
		}
		return out;
	}, [text, query]);

	if (!parts) return <>{text}</>;
	return (
		<>
			{parts.map((part, i) =>
				part.hit ? (
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: positional slices of one immutable string
						key={i}
						style={{
							background:
								"color-mix(in oklch, var(--mfw-warn) 40%, transparent)",
							color: "inherit",
						}}
					>
						{part.text}
					</mark>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional slices of one immutable string
					<span key={i}>{part.text}</span>
				),
			)}
		</>
	);
}

/** The kind badge used on run cards and the runs list. */
export function KindChip({ kind }: { kind: string }) {
	return <Chip>{kind}</Chip>;
}
