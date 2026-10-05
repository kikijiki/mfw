import { DEF_ID_RE } from "@mfw/db/ids";
import { parseCron } from "../cron.ts";
import {
	type DefinitionLoad,
	DefinitionLoader,
	type DefinitionSource,
} from "../definitions.ts";
import type { Logger } from "../log.ts";
import {
	type EventMatcher,
	isTriggerable,
	resolveEventType,
	TRIGGERABLE_EVENTS,
	typesUnderPrefix,
	type WhereValue,
} from "./events.ts";

/**
 * The trigger definition file, `.mfw/triggers/<id>.md`. Markdown with
 * frontmatter (like lifetime): the body is documentation, only the frontmatter
 * is executable. It lives in the repo but is INERT there: nothing here arms
 * anything (see `arming.ts`), since the repository is not a trust boundary.
 *
 * Every parse failure is a quarantine with a reason, never a silent skip.
 * Unknown event types, `where` fields, placeholders and a missing `run` are all
 * rejected because otherwise they show up as "my trigger never fired".
 */

export type TriggerCatchup = "latest" | "all" | "none";
export type TriggerConcurrency = "serial" | "latest" | "drop";
export type TriggerOnFailure = "inbox" | "ignore" | "hold_dispatch";

/** `cwd: repo` is the primary checkout: possibly dirty or on another branch, but the only place untracked deploy files (`node_modules`, `.env`) exist. `MFW_SHA` is always passed for scripts needing an exact tree. */
export type TriggerScriptCwd = "repo" | "worktree";

export type TriggerTaskType =
	| "implementation"
	| "spike"
	| "epic"
	| "maintenance";

export type TriggerAction =
	| { kind: "notify"; message: string }
	| {
			kind: "script";
			run: string;
			cwd: TriggerScriptCwd;
			timeoutMs: number;
	  }
	| { kind: "agent"; prompt: string; model?: string }
	| {
			kind: "create_task";
			type: TriggerTaskType;
			/** Skip firing while a task from this definition is open; same meaning as `LifetimeDef.dedupe`. */
			dedupe: "skip_if_active" | "always";
			dod: unknown;
	  };

/** What a trigger fires FROM: an event, or a 5-field cron schedule (same grammar as `.mfw/lifetime/`). Exactly one of `on:` / `cron:` is allowed; `parseSource` enforces it. */
export type TriggerSource =
	| { kind: "event"; match: EventMatcher }
	| { kind: "cron"; schedule: string };

export interface TriggerDef {
	id: string;
	title: string;
	enabled: boolean;
	source: TriggerSource;
	action: TriggerAction;
	catchup: TriggerCatchup;
	concurrency: TriggerConcurrency;
	onFailure: TriggerOnFailure;
	retries: number;
	/** Secret names REQUESTED here; the arming record must also grant them before a script sees one. */
	secrets: string[];
	body: string;
	file: string;
	/** Exact definition reviewed when the trigger is armed. */
	definition: string;
	/** `sha256:<hex>` of the file's bytes; what arming pins. */
	hash: string;
}

/**
 * The placeholder vocabulary. Interpolated only into prompts and notify
 * messages, never a script's `run` string: `run: deploy.sh "{{task.title}}"`
 * would be a shell injection via a task title.
 */
export const PROMPT_PLACEHOLDERS = [
	"event.type",
	"event.seq",
	"delivery.id",
	"task.id",
	"task.title",
	"merge.sha",
	"merge.target",
] as const;

/** Shared with `placeholders.ts`, which renders this grammar; this file only validates names. */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 10;
const SECRET_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

class DefError extends Error {}

function fail(msg: string): never {
	throw new DefError(msg);
}

function str(fm: Record<string, unknown>, key: string): string | undefined {
	const v = fm[key];
	return v === undefined || v === null ? undefined : String(v);
}

function oneOf<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	key: string,
	fallback: T,
): T {
	if (value === undefined) return fallback;
	if (!(allowed as readonly string[]).includes(value)) {
		fail(`${key} must be one of ${allowed.join(" | ")} (got "${value}")`);
	}
	return value as T;
}

/** `on:` xor `cron:` gives what this trigger fires from. */
function parseSource(fm: Record<string, unknown>): TriggerSource {
	const hasOn = fm.on !== undefined && fm.on !== null;
	const hasCron = fm.cron !== undefined && fm.cron !== null;
	if (hasOn && hasCron) {
		fail(
			"`on` and `cron` are mutually exclusive, a trigger fires from an " +
				"event OR a schedule, not both",
		);
	}
	if (hasCron) {
		const schedule = str(fm, "cron");
		if (!schedule) fail("`cron` must be a 5-field cron expression");
		try {
			parseCron(schedule as string);
		} catch (e) {
			fail(
				`invalid \`cron\` expression: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		return { kind: "cron", schedule: schedule as string };
	}
	if (!hasOn) {
		fail("either `on` (an event) or `cron` (a schedule) is required");
	}
	return { kind: "event", match: parseMatcher(fm.on) };
}

/** `on:` in any of its three forms → a matcher, or a quarantine reason. */
export function parseMatcher(raw: unknown): EventMatcher {
	if (typeof raw === "string") return parseMatcherString(raw);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		fail(
			"`on` is required: an event type, a `type.*` glob, or { type, where }",
		);
	}
	const obj = raw as Record<string, unknown>;
	const typeRaw = obj.type;
	if (typeof typeRaw !== "string" || typeRaw.length === 0) {
		fail("`on.type` is required when `on` is a mapping");
	}
	const base = parseMatcherString(typeRaw);
	if (obj.where === undefined || obj.where === null) return base;
	if (base.kind === "prefix") {
		fail("`where` cannot be combined with a `type.*` glob, name one type");
	}
	if (
		typeof obj.where !== "object" ||
		Array.isArray(obj.where) ||
		obj.where === null
	) {
		fail("`on.where` must be a mapping of field: value");
	}
	const allowed = TRIGGERABLE_EVENTS[base.type] ?? [];
	const where: Record<string, WhereValue> = {};
	for (const [field, value] of Object.entries(
		obj.where as Record<string, unknown>,
	)) {
		if (!allowed.includes(field)) {
			fail(
				allowed.length === 0
					? `${base.type} exposes no fields to \`where\``
					: `${base.type} exposes ${allowed.join(", ")} to \`where\`, not "${field}"`,
			);
		}
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			fail(
				`\`where.${field}\` must be a scalar, equality only, no expressions`,
			);
		}
		where[field] = value;
	}
	return { kind: "where", type: base.type, where };
}

function parseMatcherString(raw: string): EventMatcher {
	const spec = raw.trim();
	if (spec.endsWith(".*")) {
		const prefix = spec.slice(0, -2);
		if (prefix.includes("*") || prefix.length === 0) {
			fail(`"${spec}" is not a valid glob, only a single trailing \`.*\``);
		}
		if (typesUnderPrefix(prefix).length === 0) {
			fail(`"${spec}" matches no triggerable event type`);
		}
		return { kind: "prefix", prefix };
	}
	const type = resolveEventType(spec);
	if (!isTriggerable(type)) {
		fail(
			`"${spec}" is not a triggerable event, ` +
				`one of: ${Object.keys(TRIGGERABLE_EVENTS).sort().join(", ")}`,
		);
	}
	return { kind: "exact", type };
}

function checkPlaceholders(text: string, field: string): void {
	const known = new Set<string>(PROMPT_PLACEHOLDERS);
	for (const m of text.matchAll(PLACEHOLDER_RE)) {
		const name = m[1] as string;
		if (!known.has(name)) {
			fail(
				`\`${field}\` uses an unknown placeholder {{${name}}}, ` +
					`known: ${PROMPT_PLACEHOLDERS.join(", ")}`,
			);
		}
	}
}

function parseAction(fm: Record<string, unknown>): TriggerAction {
	const kind = oneOf(
		str(fm, "action"),
		["notify", "script", "agent", "create_task"] as const,
		"action",
		"notify",
	);
	if (fm.action === undefined) fail("`action` is required");

	if (kind === "notify") {
		const message = str(fm, "message");
		if (!message) fail("`action: notify` needs a `message`");
		checkPlaceholders(message, "message");
		return { kind, message };
	}
	if (kind === "agent") {
		const prompt = str(fm, "prompt");
		if (!prompt) fail("`action: agent` needs a `prompt`");
		checkPlaceholders(prompt, "prompt");
		const model = str(fm, "model");
		return model ? { kind, prompt, model } : { kind, prompt };
	}
	if (kind === "create_task") {
		// Same fields as `.mfw/lifetime/<def>.md` (`type`, `dedupe`, `dod`). The
		// task's title and body come from the definition's `title` and body.
		const type = oneOf(
			str(fm, "type"),
			["implementation", "spike", "epic", "maintenance"] as const,
			"type",
			"maintenance",
		);
		const dedupe = oneOf(
			str(fm, "dedupe"),
			["skip_if_active", "always"] as const,
			"dedupe",
			"skip_if_active",
		);
		return { kind, type, dedupe, dod: fm.dod ?? null };
	}
	const run = str(fm, "run");
	if (!run) fail("`action: script` needs a `run` command");
	// Payload fields reach a script only via MFW_EVENT_JSON, never the command string.
	for (const _ of run.matchAll(PLACEHOLDER_RE)) {
		fail(
			"`run` must not interpolate placeholders, a payload field in a shell " +
				"string is an injection; read MFW_EVENT_JSON instead",
		);
	}
	const timeoutRaw = fm.timeout_ms;
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	if (timeoutRaw !== undefined && timeoutRaw !== null) {
		const n = Number(timeoutRaw);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
			fail("`timeout_ms` must be a finite positive integer");
		}
		if (n > MAX_TIMEOUT_MS) {
			fail(`\`timeout_ms\` may not exceed ${MAX_TIMEOUT_MS} (one hour)`);
		}
		timeoutMs = n;
	}
	const cwd = oneOf(
		str(fm, "cwd"),
		["repo", "worktree"] as const,
		"cwd",
		"repo",
	);
	return { kind, run, cwd, timeoutMs };
}

function parseSecrets(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) fail("`secrets` must be a list of names");
	return raw.map((v) => {
		const name = String(v);
		if (!SECRET_NAME_RE.test(name)) {
			fail(`secret name "${name}" must match ${SECRET_NAME_RE.source}`);
		}
		return name;
	});
}

export function parseTriggerDef(src: DefinitionSource): TriggerDef {
	const { fm, id, body, file, raw, hash } = src;
	const action = parseAction(fm);
	const retriesRaw = fm.retries;
	let retries = 0;
	if (retriesRaw !== undefined && retriesRaw !== null) {
		const n = Number(retriesRaw);
		if (!Number.isInteger(n) || n < 0 || n > MAX_RETRIES) {
			fail(`\`retries\` must be an integer 0..${MAX_RETRIES}`);
		}
		retries = n;
	}
	return {
		id,
		title: str(fm, "title") ?? id,
		// Only an explicit `false` disables.
		enabled: fm.enabled !== false,
		source: parseSource(fm),
		action,
		catchup: oneOf(
			str(fm, "catchup"),
			["latest", "all", "none"] as const,
			"catchup",
			"latest",
		),
		concurrency: oneOf(
			str(fm, "concurrency"),
			["serial", "latest", "drop"] as const,
			"concurrency",
			"serial",
		),
		onFailure: oneOf(
			str(fm, "on_failure"),
			["inbox", "ignore", "hold_dispatch"] as const,
			"on_failure",
			"inbox",
		),
		retries,
		secrets: parseSecrets(fm.secrets),
		body,
		file,
		definition: raw,
		hash,
	};
}

export function loadTriggerDefs(
	dir: string,
	log: Logger,
): Promise<DefinitionLoad<TriggerDef>> {
	return new DefinitionLoader<TriggerDef>({
		dir,
		idRe: DEF_ID_RE,
		kind: "trigger",
		log,
		parse: parseTriggerDef,
	}).load();
}
