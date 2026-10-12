import type { AgentEvent } from "@mfw/daemon/agents/events";

import type { TranscriptItem } from "./entries";

/**
 * Subagents in a transcript, pure. The drivers tag a subagent's entries with
 * `parent` (the id of the `Agent`/`Task` call that started it, or a Codex
 * sub-thread id); `buildItems` carries that as `item.parent`. Everything here
 * reads those links: how deep an entry sits, whether a collapsed subagent
 * hides it, and the slice of the parent transcript that is one subagent's.
 */

/** One subagent as the transcript shows it, keyed by its starting call id. */
export interface SubagentGroup {
	key: string;
	/** The subagent that started this one; null for the run's own. */
	parentKey: string | null;
	/** The `Agent` call item (absent for a Codex thread, or a window cut). */
	call: Extract<TranscriptItem, { kind: "tool" }> | null;
	agentType: string | null;
	description: string;
	/** Entries that name this subagent as their parent. */
	entries: number;
	/** Tool calls among them. */
	tools: number;
	/** The call has a result (a background launch counts: it settles when the job ends). */
	finished: boolean;
}

const AGENT_TOOLS = new Set(["agent", "task"]);

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: {};
}

/** Every subagent in the item list, in transcript order. */
export function subagentGroups(
	items: readonly TranscriptItem[],
): Map<string, SubagentGroup> {
	const groups = new Map<string, SubagentGroup>();
	const ensure = (key: string, parentKey: string | null): SubagentGroup => {
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				parentKey,
				call: null,
				agentType: null,
				description: key,
				entries: 0,
				tools: 0,
				finished: false,
			};
			groups.set(key, g);
		}
		return g;
	};
	for (const item of items) {
		if (item.kind === "tool" && AGENT_TOOLS.has(item.name.toLowerCase())) {
			const g = ensure(item.id, item.parent ?? null);
			const input = asRecord(item.input);
			g.call = item;
			g.parentKey = item.parent ?? null;
			g.agentType =
				typeof input.subagent_type === "string" ? input.subagent_type : null;
			g.description =
				(typeof input.description === "string" && input.description) ||
				(typeof input.prompt === "string" && input.prompt) ||
				item.id;
			g.finished = item.result !== null;
		}
		if (item.parent !== undefined) {
			const g = ensure(item.parent, null);
			g.entries++;
			if (item.kind === "tool") g.tools++;
		}
	}
	return groups;
}

/** How deeply an entry is nested: 0 for the run's own entries. */
export function depthOf(
	item: Pick<TranscriptItem, "parent">,
	groups: ReadonlyMap<string, SubagentGroup>,
): number {
	let depth = 0;
	let key = item.parent;
	const seen = new Set<string>();
	while (key !== undefined && !seen.has(key)) {
		seen.add(key);
		depth++;
		key = groups.get(key)?.parentKey ?? undefined;
	}
	return depth;
}

/** Is a subagent shown open? A running one is; a finished one is collapsed until toggled. */
export function isSubagentOpen(
	group: SubagentGroup,
	toggled: ReadonlySet<string>,
): boolean {
	return !group.finished !== toggled.has(group.key);
}

/**
 * The items a person sees: those inside a collapsed subagent (or inside one
 * nested in it) are dropped. The `Agent` call itself always stays, carrying
 * the toggle.
 */
export function visibleItems(
	items: readonly TranscriptItem[],
	toggled: ReadonlySet<string>,
	groups: ReadonlyMap<string, SubagentGroup> = subagentGroups(items),
): TranscriptItem[] {
	if (groups.size === 0) return items.slice();
	const hidden = (parent: string | undefined): boolean => {
		const seen = new Set<string>();
		let key = parent;
		while (key !== undefined && !seen.has(key)) {
			seen.add(key);
			const g = groups.get(key);
			if (g && !isSubagentOpen(g, toggled)) return true;
			key = g?.parentKey ?? undefined;
		}
		return false;
	};
	return items.filter((item) => !hidden(item.parent));
}

/** The chain of subagent keys from an entry's own up to the outermost. */
export function ancestry(
	parent: string | undefined,
	groups: ReadonlyMap<string, SubagentGroup>,
): string[] {
	const out: string[] = [];
	let key = parent;
	while (key !== undefined && !out.includes(key)) {
		out.push(key);
		key = groups.get(key)?.parentKey ?? undefined;
	}
	return out;
}

/**
 * The raw events that make up one subagent: the call and its result, every
 * entry naming it as parent, and those of subagents it started. Returned in
 * transcript order; `buildItems` turns them into the inspector's blocks.
 */
export function subagentSlice(
	entries: readonly AgentEvent[],
	key: string,
): AgentEvent[] {
	const inside = new Set<string>([key]);
	const out: AgentEvent[] = [];
	for (const e of entries) {
		const parent = e.parent?.toolUseId ?? e.parent?.threadId;
		const own =
			(e.type === "tool_call" || e.type === "tool_result") && e.id === key;
		if (own || (parent !== undefined && inside.has(parent))) {
			// A nested Agent call opens its own scope.
			if (e.type === "tool_call" && AGENT_TOOLS.has(e.name.toLowerCase()))
				inside.add(e.id);
			out.push(e);
		}
	}
	return out;
}
