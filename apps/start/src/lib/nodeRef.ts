/**
 * Node refs: the typed address of anything the UI can select (design §2.3).
 *
 * ```
 * brain
 * task:MFW-41      group:01J…      run:01J…      turn:01J…
 * sub:<runId>/<callId>             decision:123  merge:45
 * ```
 *
 * A ref is a string so it fits a URL (`?node=`) and a cache key unchanged;
 * `parseNodeRef` is the only place the grammar is read and `formatNodeRef` the
 * only place it is written. Pure and dependency free: `routes.tsx`, the
 * inspector and the palette all go through it.
 */

export type NodeRef = string;

export type ParsedNodeRef =
	| { kind: "brain" }
	| { kind: "task"; id: string }
	| { kind: "group"; id: string }
	| { kind: "run"; id: string }
	| { kind: "turn"; id: string }
	| { kind: "sub"; runId: string; callId: string }
	| { kind: "decision"; id: number }
	| { kind: "merge"; id: number };

export type NodeKind = ParsedNodeRef["kind"];

export const NODE_KINDS = [
	"brain",
	"task",
	"group",
	"run",
	"turn",
	"sub",
	"decision",
	"merge",
] as const satisfies readonly NodeKind[];

/** Whitespace and control characters never appear in an id; refusing them keeps a pasted URL from smuggling a newline into a query key. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
const BAD_ID = /[\s\u0000-\u001f\u007f]/;
const MAX_LENGTH = 256;

function plainId(raw: string): string | null {
	if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
	if (BAD_ID.test(raw)) return null;
	return raw;
}

function numericId(raw: string): number | null {
	if (!/^\d{1,15}$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) ? n : null;
}

/** Read a ref; anything outside the grammar is `null`, never a guess. */
export function parseNodeRef(input: unknown): ParsedNodeRef | null {
	if (typeof input !== "string") return null;
	if (input === "brain") return { kind: "brain" };
	const colon = input.indexOf(":");
	if (colon <= 0) return null;
	const kind = input.slice(0, colon);
	const rest = input.slice(colon + 1);
	switch (kind) {
		case "task":
		case "group":
		case "run":
		case "turn": {
			const id = plainId(rest);
			return id === null ? null : { kind, id };
		}
		case "sub": {
			const slash = rest.indexOf("/");
			if (slash <= 0) return null;
			const runId = plainId(rest.slice(0, slash));
			const callId = plainId(rest.slice(slash + 1));
			return runId === null || callId === null
				? null
				: { kind: "sub", runId, callId };
		}
		case "decision":
		case "merge": {
			const id = numericId(rest);
			return id === null ? null : { kind, id };
		}
		default:
			return null;
	}
}

export function isNodeRef(input: unknown): input is NodeRef {
	return parseNodeRef(input) !== null;
}

export function formatNodeRef(ref: ParsedNodeRef): NodeRef {
	switch (ref.kind) {
		case "brain":
			return "brain";
		case "sub":
			return `sub:${ref.runId}/${ref.callId}`;
		default:
			return `${ref.kind}:${ref.id}`;
	}
}

/** Shorthands for the common builders, so call sites do not spell the grammar. */
export const nodeRef = {
	brain: (): NodeRef => "brain",
	task: (id: string): NodeRef => `task:${id}`,
	group: (id: string): NodeRef => `group:${id}`,
	run: (id: string): NodeRef => `run:${id}`,
	turn: (id: string): NodeRef => `turn:${id}`,
	sub: (runId: string, callId: string): NodeRef => `sub:${runId}/${callId}`,
	decision: (id: number): NodeRef => `decision:${id}`,
	merge: (id: number): NodeRef => `merge:${id}`,
} as const;

/** The task id a ref names when it is a task ref (the board, the palette), else `null`. */
export function taskIdOf(ref: NodeRef | null | undefined): string | null {
	const parsed = parseNodeRef(ref);
	return parsed?.kind === "task" ? parsed.id : null;
}

/** Short human name for a ref (breadcrumb, tab title): `run:01J…` → `run 01J…`. */
export function describeNodeRef(ref: ParsedNodeRef): string {
	switch (ref.kind) {
		case "brain":
			return "brain";
		case "sub":
			return `subagent ${ref.callId}`;
		default:
			return `${ref.kind} ${ref.id}`;
	}
}
