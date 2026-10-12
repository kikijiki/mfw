import type { KeyBinding } from "../../lib/keyboard";
import { type NodeRef, parseNodeRef } from "../../lib/nodeRef";
import { href } from "../../routes";

/**
 * The command palette's model (design §10.3), pure so ranking, targets and
 * the key bindings are unit-tested without cmdk or a DOM.
 */

export interface PaletteTask {
	id: string;
	title: string;
	status: string;
}

export interface PaletteCommand {
	id: string;
	label: string;
	/** Binding key, shown beside the command; the same string `paletteBindings` registers. */
	keys?: string;
	/** In-app path to go to. */
	to: string;
}

/** Where selecting a node goes: a task opens in the board's docked inspector, anything else as a page. */
export function nodeTarget(project: string, ref: NodeRef): string {
	const parsed = parseNodeRef(ref);
	if (parsed?.kind === "task") return href.board(project, { node: ref });
	return href.node(project, ref);
}

/** Navigation commands. `project` is null before any project is attached; project commands then drop out. */
export function navCommands(project: string | null): PaletteCommand[] {
	const out: PaletteCommand[] = [
		{ id: "go-home", label: "Go to Home", keys: "g h", to: href.home() },
		{ id: "go-fleet", label: "Go to Fleet", keys: "g l", to: href.fleet() },
	];
	if (project) {
		out.push(
			{
				id: "go-board",
				label: `Go to Board (${project})`,
				keys: "g b",
				to: href.board(project),
			},
			{
				id: "go-flow",
				label: `Go to Flow (${project})`,
				keys: "g f",
				to: href.flow(project),
			},
		);
	}
	return out;
}

/**
 * The global shortcuts the palette owns: open it, and the `g` sequences. One
 * list feeds both the registry and the palette's key hints, so they cannot
 * disagree.
 */
export function paletteBindings(opts: {
	project: string | null;
	go: (to: string) => void;
	open: () => void;
}): KeyBinding[] {
	return [
		{
			key: "mod+k",
			label: "Command palette",
			group: "Global",
			run: opts.open,
		},
		...navCommands(opts.project).map(
			(c): KeyBinding => ({
				key: c.keys ?? "",
				label: c.label,
				group: "Go to",
				run: () => opts.go(c.to),
			}),
		),
	];
}

/** Subsequence test: are the letters of `needle` in `hay`, in order? */
function isSubsequence(needle: string, hay: string): boolean {
	let i = 0;
	for (const ch of hay) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return needle.length === 0;
}

/** How well a task matches; 0 is no match. An id hit outranks a title hit. */
export function scoreTask(task: PaletteTask, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) return 1;
	const id = task.id.toLowerCase();
	const title = task.title.toLowerCase();
	if (id === q) return 1000;
	if (id.startsWith(q)) return 900;
	if (id.includes(q)) return 800;
	if (title.startsWith(q)) return 700;
	if (title.includes(q)) return 600;
	const tokens = q.split(/\s+/);
	const hay = `${id} ${title}`;
	if (tokens.length > 1 && tokens.every((t) => hay.includes(t))) return 400;
	if (q.length >= 3 && isSubsequence(q.replace(/\s+/g, ""), title)) return 100;
	return 0;
}

const SETTLED = new Set(["done", "archived"]);

/**
 * Tasks for a query, best first. With no query, open work comes before
 * settled work. Capped: a board of hundreds of tasks must not become hundreds
 * of palette rows.
 */
export function rankTasks(
	tasks: readonly PaletteTask[],
	query: string,
	limit = 50,
): PaletteTask[] {
	return tasks
		.map((task, index) => ({ task, index, score: scoreTask(task, query) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const settled =
				Number(SETTLED.has(a.task.status)) - Number(SETTLED.has(b.task.status));
			return settled || a.index - b.index;
		})
		.slice(0, limit)
		.map((r) => r.task);
}

/** Commands matching a query by label or keys. `>` is stripped: it asks for commands only. */
export function filterCommands(
	commands: readonly PaletteCommand[],
	query: string,
): PaletteCommand[] {
	const q = query.replace(/^>/, "").trim().toLowerCase();
	if (!q) return [...commands];
	return commands.filter(
		(c) =>
			c.label.toLowerCase().includes(q) ||
			(c.keys ?? "").replace(/\s+/g, "").includes(q.replace(/\s+/g, "")),
	);
}

/** `>` lists commands only (verbs); anything else searches nodes and commands. */
export function commandsOnly(query: string): boolean {
	return query.startsWith(">");
}

/** The ref the query spells, when it is a well-formed node ref: `run:01J…` offers "Open run:01J…". */
export function refFromQuery(query: string): NodeRef | null {
	const q = query.trim();
	return parseNodeRef(q) ? q : null;
}
