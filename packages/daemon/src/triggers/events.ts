import type { StoredEvent } from "@mfw/db/eventlog";

/**
 * The public contract of events a trigger may subscribe to and filter on.
 * A subset of the `MfwEvent` union; the rest is implementation detail free to
 * change.
 *
 *  - listed types and their `where` fields are stable; a rename needs an
 *    `EVENT_ALIASES` entry;
 *  - a definition naming an unknown type is quarantined, not ignored (a typo
 *    must not produce silence).
 *
 * `where` is equality on the named scalar fields only. No expression language:
 * evaluating attacker-influenceable payload content is an injection surface.
 */

export const TRIGGERABLE_EVENTS: Readonly<Record<string, readonly string[]>> = {
	"task.status_changed": ["from", "to", "actor"],
	"task.created": ["source"],
	/** Carries `sha` and `target`; published before `onMerged` runs, so the target ref has already moved. */
	"merge.completed": ["target"],
	"merge.parked": ["target", "kind"],
	"merge.board_reverted": ["target"],
	"main.red": [],
	"main.green": [],
	"clarify.raised": ["kind"],
	"board.suspended": ["reason"],
	"lifetime.fired": ["defId"],
};

/** `old type name → current type name`, consulted at definition load and event match. */
export const EVENT_ALIASES: Readonly<Record<string, string>> = {};

export function resolveEventType(
	type: string,
	aliases: Readonly<Record<string, string>> = EVENT_ALIASES,
): string {
	return aliases[type] ?? type;
}

export function isTriggerable(type: string): boolean {
	return Object.hasOwn(TRIGGERABLE_EVENTS, type);
}

/** The event types a `prefix.*` glob covers, resolved against the allowlist. */
export function typesUnderPrefix(prefix: string): string[] {
	return Object.keys(TRIGGERABLE_EVENTS).filter((t) =>
		t.startsWith(`${prefix}.`),
	);
}

/**
 * What an action handler reads off a dispatch's event. Real `StoredEvent`s
 * satisfy it; `cron:` triggers have no log row and get a synthetic value
 * (`cronTickEvent` in `cron-source.ts`).
 */
export interface TriggerEvent {
	type: string;
	seq: number;
	ts: number;
	payload: Record<string, unknown>;
}

export type WhereValue = string | number | boolean;

export type EventMatcher =
	/** `on: merge.completed` */
	| { kind: "exact"; type: string }
	/** `on: task.*`, a single-level prefix glob. */
	| { kind: "prefix"; prefix: string }
	/** `on: { type, where: { field: value } }` */
	| {
			kind: "where";
			type: string;
			where: Readonly<Record<string, WhereValue>>;
	  };

/** Every allowlisted type this matcher can ever select. */
export function matcherTypes(m: EventMatcher): string[] {
	return m.kind === "prefix" ? typesUnderPrefix(m.prefix) : [m.type];
}

/**
 * Does this stored event satisfy the matcher? Non-allowlisted events never
 * match (enforced here as well as at load, so a type removed from the list
 * stops firing). Values compare by string form, since YAML types
 * `where` values inconsistently with payload fields.
 */
export function matchesEvent(
	m: EventMatcher,
	event: Pick<StoredEvent, "type" | "payload">,
	aliases: Readonly<Record<string, string>> = EVENT_ALIASES,
): boolean {
	const type = resolveEventType(event.type, aliases);
	if (!isTriggerable(type)) return false;
	if (m.kind === "prefix") return type.startsWith(`${m.prefix}.`);
	if (type !== m.type) return false;
	if (m.kind === "exact") return true;
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	for (const [field, expected] of Object.entries(m.where)) {
		const actual = payload[field];
		if (actual === undefined || actual === null) return false;
		if (String(actual) !== String(expected)) return false;
	}
	return true;
}
