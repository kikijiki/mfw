import { z } from "zod";
import { ACT_TOOLS } from "./actions.ts";
import type { Provenance } from "./decision-rights.ts";
import { READ_TOOLS, type ReadTool } from "./reads.ts";

/**
 * What a chat turn can reach (DESIGN W2 "Chat turns are read-only"). The model
 * runs with no tools of its own: it asks for a read in its reply and the host
 * runs it here. Two independent gates refuse anything else: `validateChatStep`
 * on the model's output, and `ChatToolRegistry.call` on the way to the service.
 *
 * `diff` and `run_report` are left out on purpose: both run git inside a run's
 * agent-writable workspace, which is not a side-effect-free read.
 */
export const CHAT_READ_TOOLS = [
	"board",
	"task",
	"frontier",
	"runs",
	"run_log",
	"capacity",
	"outcomes",
	"decisions",
] as const satisfies readonly ReadTool[];
export type ChatReadTool = (typeof CHAT_READ_TOOLS)[number];

const ACT: ReadonlySet<string> = new Set(ACT_TOOLS);
const ALLOWED: ReadonlySet<string> = new Set(CHAT_READ_TOOLS);

export const CHAT_ANSWER_MAX_CHARS = 2000;
export const CHAT_MAX_CITATIONS = 20;

export class ChatToolRefused extends Error {
	constructor(
		readonly code: "act_tool" | "not_allowed",
		readonly tool: string,
	) {
		super(
			code === "act_tool"
				? `'${tool}' is an act tool: a chat turn is read-only`
				: `'${tool}' is not a chat read tool`,
		);
		this.name = "ChatToolRefused";
	}
}

function refusal(tool: string): ChatToolRefused | null {
	if (ACT.has(tool)) return new ChatToolRefused("act_tool", tool);
	return ALLOWED.has(tool) ? null : new ChatToolRefused("not_allowed", tool);
}

interface ReadPort {
	read(tool: string, args: unknown): Promise<unknown>;
	provenanceOf(tool: ReadTool, args: unknown): Promise<Provenance[]>;
}

/** The only path from a chat turn to the daemon. */
export class ChatToolRegistry {
	readonly tools: readonly string[];

	constructor(
		private readonly reads: ReadPort,
		allow: readonly string[] = CHAT_READ_TOOLS,
	) {
		for (const t of allow) {
			if (ACT.has(t) || !(READ_TOOLS as readonly string[]).includes(t)) {
				throw new ChatToolRefused(ACT.has(t) ? "act_tool" : "not_allowed", t);
			}
		}
		this.tools = Object.freeze([...allow]);
	}

	/** Provenance is resolved before the content, as for a work turn's reads. */
	async call(
		tool: string,
		args: unknown,
	): Promise<{ result: unknown; provenance: Provenance[] }> {
		const refused = refusal(tool);
		if (refused || !this.tools.includes(tool)) {
			throw refused ?? new ChatToolRefused("not_allowed", tool);
		}
		const provenance = await this.reads.provenanceOf(tool as ReadTool, args);
		// No turn id: chat reads must not count against, or taint, a work turn.
		return { result: await this.reads.read(tool, args), provenance };
	}
}

export const CITATION_KINDS = ["task", "run", "decision", "view"] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];
/** Screens a mechanical fact can point at. */
export const CHAT_VIEWS = [
	"capacity",
	"outcomes",
	"needs_you",
	"runs",
	"decisions",
] as const;

export interface ChatCitation {
	kind: CitationKind;
	id: string;
}

const Citation = z
	.object({
		kind: z.enum(CITATION_KINDS),
		id: z.string().min(1).max(100),
	})
	.strict();

const ReadStep = z
	.object({
		read: z
			.object({
				tool: z.string().min(1).max(64),
				args: z.record(z.string(), z.unknown()).default({}),
			})
			.strict(),
	})
	.strict();

const AnswerStep = z
	.object({
		answer: z
			.object({
				text: z.string().trim().min(1).max(CHAT_ANSWER_MAX_CHARS),
				citations: z.array(Citation).max(CHAT_MAX_CITATIONS).default([]),
				wants_action: z.boolean().default(false),
			})
			.strict(),
	})
	.strict();

export type ChatStep =
	| { kind: "read"; tool: ChatReadTool; args: Record<string, unknown> }
	| {
			kind: "answer";
			text: string;
			citations: ChatCitation[];
			wantsAction: boolean;
	  }
	| { kind: "refused"; tool: string; message: string }
	| { kind: "invalid"; message: string };

/** The validator: one model reply to one permitted step. */
export function validateChatStep(raw: unknown): ChatStep {
	const read = ReadStep.safeParse(raw);
	if (read.success) {
		const { tool, args } = read.data.read;
		const refused = refusal(tool);
		if (refused) return { kind: "refused", tool, message: refused.message };
		return { kind: "read", tool: tool as ChatReadTool, args };
	}
	const answer = AnswerStep.safeParse(raw);
	if (answer.success) {
		const a = answer.data.answer;
		return {
			kind: "answer",
			text: a.text,
			citations: a.citations,
			wantsAction: a.wants_action,
		};
	}
	// An act call in any other shape is still named as a refusal.
	const named = (raw as { tool?: unknown } | null)?.tool;
	if (typeof named === "string" && refusal(named)) {
		return {
			kind: "refused",
			tool: named,
			message: refusal(named)?.message ?? "",
		};
	}
	return {
		kind: "invalid",
		message: 'reply with one JSON object: {"read":...} or {"answer":...}',
	};
}

/** What a read result names, so an answer can only cite what the turn saw. */
export function observedRefs(tool: string, result: unknown): ChatCitation[] {
	const r = (result ?? {}) as {
		id?: unknown;
		runId?: unknown;
		tasks?: { id?: unknown }[];
		runs?: { id?: unknown }[];
		decisions?: { id?: unknown; taskId?: unknown }[];
	};
	const out: ChatCitation[] = [];
	const add = (kind: CitationKind, id: unknown) => {
		if (typeof id === "string" && id) out.push({ kind, id });
		else if (typeof id === "number") out.push({ kind, id: String(id) });
	};
	if (tool === "task") add("task", r.id);
	if (tool === "run_log") add("run", r.runId);
	for (const t of r.tasks ?? []) add("task", t.id);
	for (const x of r.runs ?? []) add("run", x.id);
	for (const d of r.decisions ?? []) {
		add("decision", d.id);
		add("task", d.taskId);
	}
	if (tool === "capacity") add("view", "capacity");
	if (tool === "outcomes") add("view", "outcomes");
	if (tool === "runs") add("view", "runs");
	if (tool === "decisions") add("view", "decisions");
	return out;
}
