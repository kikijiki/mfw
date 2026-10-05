import {
	Document,
	isMap,
	isSeq,
	parse as parseYaml,
	stringify as stringifyYaml,
} from "yaml";
import { z } from "zod";
import { normalizeOwnsPattern, validateOwnsPattern } from "./ownership.ts";
import {
	type Priority,
	TASK_SOURCES,
	type TaskSize,
	type TaskSource,
	type TaskType,
	type VerifierKind,
} from "./types.ts";

/**
 * Task file format; the file is the canonical representation of a task.
 *
 * Frontmatter holds authoring fields plus lineage (`created`, `source`,
 * `split_from`, `lifetime_def`) and `blocked_reason`. It does not carry
 * `status` (the containing directory, see `board.ts`) or `claimed_by` (runtime
 * state); both are stripped with a warning.
 *
 * The body is free prose except two machine-owned regions, extracted on parse
 * and re-rendered on write:
 * 1. the checklist under `## Acceptance Criteria` (up to the next `#`/`##`).
 * 2. one fenced block with info string `verification` (legacy `dod` readable),
 *    matched by info string only, so other yaml fences are inert prose.
 *
 * Rendering is deterministic: render∘parse∘render is a fixpoint, and
 * parse(render(x)) round-trips for bodies free of machine-owned regions and
 * with balanced fences.
 */

const TASK_TYPES = ["implementation", "spike", "epic", "maintenance"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const TASK_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export const MODEL_TIERS = ["light", "standard", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
const VERIFIERS = ["deterministic", "llm-judge"] as const;

/** Fields the filesystem or the run engine owns; ignored (with a warning). */
const MACHINE_FIELDS = new Set(["status", "claimed_by", "updated"]);

// ---------------------------------------------------------------------------
// Mechanical verification (`DefinitionOfDone` kept as a compatibility alias).
// ---------------------------------------------------------------------------

const timeoutSchema = z.number().positive().optional();

const runCheckSchema = z.object({
	run: z.string().min(1),
	expect_exit: z.number().int().default(0),
	timeout: timeoutSchema,
});

const filesExistCheckSchema = z.object({
	files_exist: z.array(z.string().min(1)).min(1),
	timeout: timeoutSchema,
});

// Accept `true`/`false` or the legacy `{ must_change: … }` object form.
const diffCheckSchema = z.object({
	diff_against_base: z.preprocess((v) => {
		if (typeof v === "object" && v !== null) {
			return (v as { must_change?: unknown }).must_change !== false;
		}
		return v;
	}, z.boolean()),
	timeout: timeoutSchema,
});

const dodCheckSchema = z.union([
	runCheckSchema,
	filesExistCheckSchema,
	diffCheckSchema,
]);

const dodSchema = z
	.object({
		verifier: z.enum(VERIFIERS).default("deterministic"),
		checks: z.array(dodCheckSchema).default([]),
	})
	.refine((d) => d.verifier !== "deterministic" || d.checks.length > 0, {
		message: "a deterministic verifier requires at least one check",
	});

/** Canonical verification schema, shared by parser, verifier and API. */
export const VerificationPlanSchema = dodSchema;
export const VerificationCheckSchema = dodCheckSchema;
/** @deprecated Read legacy `dod` inputs only; use VerificationPlanSchema. */
export const DoDSchema = VerificationPlanSchema;
/** @deprecated Use VerificationCheckSchema. */
export const DoDCheckSchema = VerificationCheckSchema;

export type DoDCheck =
	| { run: string; expect_exit: number; timeout?: number }
	| { files_exist: string[]; timeout?: number }
	| { diff_against_base: boolean; timeout?: number };

export interface DefinitionOfDone {
	verifier: VerifierKind;
	checks: DoDCheck[];
}

export type VerificationCheck = DoDCheck;
export type VerificationPlan = DefinitionOfDone;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Treat explicit YAML `null` the same as an absent key. */
function nullish<T extends z.ZodType>(schema: T) {
	return z.preprocess((v) => v ?? undefined, schema);
}

const resourceIdSchema = z.string().trim().min(1, "resource id is required");
const positiveIntegerAmountSchema = z
	.number()
	.int("resource amount must be a whole integer")
	.positive("resource amount must be greater than zero")
	.max(
		Number.MAX_SAFE_INTEGER,
		"resource amount exceeds the safe integer range",
	);
const iecByteAmountSchema = z
	.string()
	.regex(
		/^[1-9][0-9]* (?:B|KiB|MiB|GiB|TiB|PiB|EiB)$/,
		"RAM amount must be a positive whole number with an explicit IEC unit (for example '8 GiB')",
	)
	.refine((value) => {
		const match = /^([1-9][0-9]*) (B|KiB|MiB|GiB|TiB|PiB|EiB)$/.exec(value);
		if (!match) return false;
		const multipliers: Record<string, bigint> = {
			B: 1n,
			KiB: 1n << 10n,
			MiB: 1n << 20n,
			GiB: 1n << 30n,
			TiB: 1n << 40n,
			PiB: 1n << 50n,
			EiB: 1n << 60n,
		};
		return (
			BigInt(match[1] as string) *
				(multipliers[match[2] as string] as bigint) <=
			9_223_372_036_854_775_807n
		);
	}, "RAM amount exceeds the supported 64-bit byte range");

const hostAmountSchema = z.union([
	positiveIntegerAmountSchema,
	iecByteAmountSchema,
]);

export const TaskResourceRequirementSchema = z.union([
	resourceIdSchema,
	z
		.object({
			scope: z.literal("project"),
			id: resourceIdSchema,
			amount: z.literal(1).optional(),
		})
		.strict(),
	z
		.object({
			scope: z.literal("host"),
			id: resourceIdSchema,
			amount: hostAmountSchema.optional(),
		})
		.strict(),
]);

export type TaskResourceRequirement = z.infer<
	typeof TaskResourceRequirementSchema
>;

export const LocalStagingResourceRequirementSchema = z
	.object({
		scope: z.literal("host"),
		id: resourceIdSchema,
		amount: hostAmountSchema.optional(),
	})
	.strict();

export type LocalStagingResourceRequirement = z.infer<
	typeof LocalStagingResourceRequirementSchema
>;

function rejectDuplicateResources(
	items: readonly (string | { scope: "project" | "host"; id: string })[],
	ctx: z.RefinementCtx,
): void {
	const seen = new Map<string, number>();
	for (const [index, item] of items.entries()) {
		const scope = typeof item === "string" ? "project" : item.scope;
		const id = typeof item === "string" ? item : item.id;
		const key = `${scope}\0${id}`;
		const first = seen.get(key);
		if (first !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: [index],
				message: `duplicate ${scope} resource '${id}' (first declared at index ${first})`,
			});
		} else {
			seen.set(key, index);
		}
	}
}

/**
 * What lets a parked task (blocked, or backlog with `ready_mode: manual`) move
 * back to ready by itself. Every condition must hold. A condition is a fact
 * the daemon can check, never elapsed time.
 */
export const ReopenConditionSchema = z.union([
	z.object({ task_done: z.string().min(1) }).strict(),
	z
		.object({
			run: z.string().min(1),
			expect_exit: z.number().int().default(0),
			/** Seconds. */
			timeout: z.number().positive().optional(),
		})
		.strict(),
]);

export type ReopenCondition =
	| { task_done: string }
	| { run: string; expect_exit: number; timeout?: number };

/** `owns` patterns: repository-relative, validated by `ownership.ts`. */
export const OwnsSchema = z
	.array(z.string())
	.superRefine((patterns, ctx) => {
		for (const [index, pattern] of patterns.entries()) {
			const reason = validateOwnsPattern(pattern);
			if (reason) {
				ctx.addIssue({
					code: "custom",
					path: [index],
					message: `owns '${pattern}': ${reason}`,
				});
			}
		}
	})
	.transform((patterns) => [...new Set(patterns.map(normalizeOwnsPattern))]);

const taskResourceRequirementsSchema = z
	.array(TaskResourceRequirementSchema)
	.superRefine(rejectDuplicateResources);
const localStagingResourceRequirementsSchema = z
	.array(LocalStagingResourceRequirementSchema)
	.superRefine(rejectDuplicateResources);

const frontmatterSchema = z.object({
	id: z.string().min(1).optional(),
	rev: z.number().int().nonnegative().optional(),
	title: z.string().min(1),
	type: z.enum(TASK_TYPES),
	priority: z.enum(PRIORITIES),
	size: nullish(z.enum(TASK_SIZES).nullable().default(null)),
	labels: nullish(z.array(z.string()).default([])),
	parent: nullish(z.string().nullable().default(null)),
	depends_on: nullish(z.array(z.string()).default([])),
	spike_timebox: nullish(z.string().nullable().default(null)),
	requires_resources: nullish(taskResourceRequirementsSchema.default([])),
	/** Generic target kind. Provider-specific shape belongs to its target task. */
	execution_target: nullish(z.string().min(1).default("local")),
	/** Explicit daemon-host work needed by a non-local target. */
	local_staging_resources: nullish(
		localStagingResourceRequirementsSchema.default([]),
	),
	/** Machine-side workload grant ids; never credential values. */
	workload_secret_grants: nullish(
		z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).default([]),
	),
	/**
	 * Require human review before merge. False by default (a gate is opt-in).
	 * Project `changeReview: human` can also require it; this is the only
	 * per-task control (see `reviewGated` in step-runner.ts).
	 */
	require_review: nullish(z.boolean().default(false)),
	// Lineage and human-facing state. `created` is an ISO string.
	created: nullish(z.string().nullable().default(null)),
	source: nullish(z.enum(TASK_SOURCES).default("human")),
	split_from: nullish(z.string().nullable().default(null)),
	lifetime_def: nullish(z.string().nullable().default(null)),
	blocked_reason: nullish(z.string().nullable().default(null)),
	/** Verbatim capture text, kept after `draft` ends so a bad expansion can be diagnosed or redone. */
	draft_prompt: nullish(z.string().nullable().default(null)),
	/** Destination chosen at capture time; meaningful while `draft`, kept as provenance. */
	after_expansion: nullish(z.enum(["backlog", "ready"]).default("ready")),
	/** Whether backlog is a deliberate parking state or promotes once dependencies are satisfied. */
	ready_mode: nullish(z.enum(["automatic", "manual"]).default("automatic")),
	/** Idempotency key supplied by the quick-capture client. */
	capture_id: nullish(z.string().nullable().default(null)),
	/** Paths this task may edit (see `ownership.ts`). Empty = undeclared, unconstrained. */
	owns: nullish(OwnsSchema.default([])),
	/** Model class for the run; null = the project model. */
	model_tier: nullish(z.enum(MODEL_TIERS).nullable().default(null)),
	/** The task whose run discovered this follow-up. */
	discovered_from: nullish(z.string().nullable().default(null)),
	/** Immutable follow-up replay identity. */
	discovery_key: nullish(z.string().nullable().default(null)),
	/** Conditions that move a parked task back to ready (see `ReopenConditionSchema`). */
	reopen_when: nullish(z.array(ReopenConditionSchema).default([])),
});

const KNOWN_FIELDS = new Set(Object.keys(frontmatterSchema.shape));

export interface TaskFrontmatter {
	id?: string;
	rev?: number;
	title: string;
	type: TaskType;
	priority: Priority;
	size: TaskSize | null;
	labels: string[];
	parent: string | null;
	depends_on: string[];
	spike_timebox: string | null;
	requires_resources: TaskResourceRequirement[];
	execution_target: string;
	local_staging_resources: LocalStagingResourceRequirement[];
	workload_secret_grants: string[];
	require_review: boolean;
	created: string | null;
	source: TaskSource;
	split_from: string | null;
	lifetime_def: string | null;
	blocked_reason: string | null;
	draft_prompt: string | null;
	after_expansion: "backlog" | "ready";
	ready_mode: "automatic" | "manual";
	capture_id?: string | null;
	owns: string[];
	model_tier: ModelTier | null;
	discovered_from: string | null;
	discovery_key?: string | null;
	reopen_when: ReopenCondition[];
}

// ---------------------------------------------------------------------------
// Parsed file
// ---------------------------------------------------------------------------

export interface TaskCriterion {
	text: string;
	checked: boolean;
}

export interface TaskFile {
	frontmatter: TaskFrontmatter;
	/** Body prose with the machine-owned regions removed (trimmed). */
	body: string;
	criteria: TaskCriterion[];
	dod: DefinitionOfDone | null;
}

export type ParseTaskFileResult =
	| { ok: true; file: TaskFile; warnings: string[] }
	| { ok: false; reason: string };

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const FENCE_DELIM_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^#{1,2}[ \t]+\S/;
const CRITERIA_HEADING_RE = /^##[ \t]+acceptance criteria[ \t]*$/i;
const DOD_HEADING_RE = /^##[ \t]+definition of done[ \t]*$/i;
const VERIFICATION_HEADING_RE = /^##[ \t]+verification checks[ \t]*$/i;
const CRITERION_RE = /^- (?:\[([ xX])\][ \t]*)?(.*)$/;
const BLANK_RE = /^[ \t]*$/;

interface Fence {
	/** Line index of the opening delimiter. */
	open: number;
	/** Line index of the closing delimiter, or -1 if never closed. */
	close: number;
	/** Info string of the opening delimiter, trimmed. */
	info: string;
}

/** CommonMark-ish fence scan: nesting-safe, `~~~` and long fences included. */
function scanFences(lines: string[]): { fences: Fence[]; inFence: boolean[] } {
	const fences: Fence[] = [];
	const inFence = new Array<boolean>(lines.length).fill(false);
	let open: { line: number; char: string; len: number; info: string } | null =
		null;
	for (let i = 0; i < lines.length; i++) {
		const m = FENCE_DELIM_RE.exec(lines[i] as string);
		if (open) {
			inFence[i] = true;
			if (
				m &&
				(m[1] as string).startsWith(open.char) &&
				(m[1] as string).length >= open.len &&
				(m[2] as string).trim() === ""
			) {
				fences.push({ open: open.line, close: i, info: open.info });
				open = null;
			}
		} else if (m) {
			const info = (m[2] as string).trim();
			// A backtick fence's info string may not contain backticks.
			if ((m[1] as string).startsWith("`") && info.includes("`")) continue;
			open = {
				line: i,
				char: (m[1] as string)[0] as string,
				len: (m[1] as string).length,
				info,
			};
			inFence[i] = true;
		}
	}
	if (open) fences.push({ open: open.line, close: -1, info: open.info });
	return { fences, inFence };
}

function formatZodIssues(error: z.ZodError): string {
	return error.issues
		.map((i) =>
			i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
		)
		.join("; ");
}

/** Strip leading blank lines and all trailing whitespace. */
function normalizeBody(body: string): string {
	return body.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/** Split YAML frontmatter from the body. Exported for lifetime definitions, which share the envelope but not the schema. */
export function splitFrontmatter(raw: string): {
	data: unknown;
	body: string;
} {
	const m = FRONTMATTER_RE.exec(raw);
	if (!m) throw new Error("missing or malformed YAML frontmatter");
	return { data: parseYaml(m[1] as string), body: m[2] ?? "" };
}

/** Parse task-file markdown. Never throws; malformed input yields `{ ok: false, reason }`. */
export function parseTaskFile(raw: string): ParseTaskFileResult {
	const normalized = raw.replace(/\r\n/g, "\n");
	const m = FRONTMATTER_RE.exec(normalized);
	if (!m) return { ok: false, reason: "missing or malformed YAML frontmatter" };

	let fmData: unknown;
	try {
		fmData = parseYaml(m[1] as string);
	} catch (e) {
		return {
			ok: false,
			reason: `frontmatter: invalid YAML: ${(e as Error).message}`,
		};
	}
	if (typeof fmData !== "object" || fmData === null || Array.isArray(fmData)) {
		return { ok: false, reason: "frontmatter: must be a YAML mapping" };
	}

	const warnings: string[] = [];
	const kept: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fmData)) {
		if (KNOWN_FIELDS.has(key)) {
			kept[key] = value;
		} else if (MACHINE_FIELDS.has(key)) {
			warnings.push(`frontmatter: machine-owned field '${key}' ignored`);
		} else {
			warnings.push(`frontmatter: unknown field '${key}' ignored`);
		}
	}
	const fmResult = frontmatterSchema.safeParse(kept);
	if (!fmResult.success) {
		return {
			ok: false,
			reason: `frontmatter: ${formatZodIssues(fmResult.error)}`,
		};
	}
	const frontmatter: TaskFrontmatter = fmResult.data;

	const lines = (m[2] ?? "").split("\n");
	const { fences, inFence } = scanFences(lines);

	// --- Verification: one canonical `verification` or legacy `dod` fence ---
	const dodFences = fences.filter((f) => {
		const info = f.info.split(/\s+/)[0];
		return info === "verification" || info === "dod";
	});
	if (dodFences.length > 1) {
		return {
			ok: false,
			reason: `found ${dodFences.length} verification fences; expected exactly one`,
		};
	}
	const dodFence = dodFences[0] ?? null;
	if (dodFence && dodFence.close === -1) {
		return { ok: false, reason: "verification fence is never closed" };
	}

	let dod: DefinitionOfDone | null = null;
	const removed = new Array<boolean>(lines.length).fill(false);
	const inDodRegion = new Array<boolean>(lines.length).fill(false);
	if (dodFence) {
		let dodData: unknown;
		try {
			dodData = parseYaml(
				lines.slice(dodFence.open + 1, dodFence.close).join("\n"),
			);
		} catch (e) {
			return {
				ok: false,
				reason: `verification: invalid YAML: ${(e as Error).message}`,
			};
		}
		const dodResult = dodSchema.safeParse(dodData);
		if (!dodResult.success) {
			return {
				ok: false,
				reason: `verification: ${formatZodIssues(dodResult.error)}`,
			};
		}
		dod = dodResult.data as DefinitionOfDone;

		for (let i = dodFence.open; i <= dodFence.close; i++) {
			removed[i] = true;
			inDodRegion[i] = true;
		}
		// Swallow the heading above the fence (across blank lines); it is re-rendered.
		let j = dodFence.open - 1;
		while (j >= 0 && BLANK_RE.test(lines[j] as string)) {
			removed[j] = true;
			inDodRegion[j] = true;
			j--;
		}
		if (
			j >= 0 &&
			!inFence[j] &&
			(DOD_HEADING_RE.test(lines[j] as string) ||
				VERIFICATION_HEADING_RE.test(lines[j] as string))
		) {
			removed[j] = true;
			inDodRegion[j] = true;
			j--;
			while (j >= 0 && BLANK_RE.test(lines[j] as string)) {
				removed[j] = true;
				inDodRegion[j] = true;
				j--;
			}
		}
	}

	// --- Acceptance criteria: checklist under `## Acceptance Criteria` -------
	const criteria: TaskCriterion[] = [];
	const sectionStarts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!inFence[i] && CRITERIA_HEADING_RE.test(lines[i] as string)) {
			sectionStarts.push(i);
		}
	}
	if (sectionStarts.length > 1) {
		warnings.push(
			`found ${sectionStarts.length} '## Acceptance Criteria' sections; merging in order`,
		);
	}
	for (const start of sectionStarts) {
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (!inFence[i] && HEADING_RE.test(lines[i] as string)) {
				end = i;
				break;
			}
		}
		for (let i = start; i < end; i++) removed[i] = true;
		// Swallow blank lines directly above the heading.
		for (let j = start - 1; j >= 0 && BLANK_RE.test(lines[j] as string); j--) {
			removed[j] = true;
		}
		for (let i = start + 1; i < end; i++) {
			if (inDodRegion[i]) continue; // a dod fence inside the section
			const line = lines[i] as string;
			if (BLANK_RE.test(line)) continue;
			const item = CRITERION_RE.exec(line);
			if (item) {
				criteria.push({
					text: (item[2] as string).trimEnd(),
					// Check marks are legacy; nothing trusts them as acceptance evidence.
					checked:
						((item[1] as string | undefined) ?? "").toLowerCase() === "x",
				});
			} else {
				warnings.push(
					`Acceptance Criteria: dropped non-checklist line: ${JSON.stringify(line.trim())}`,
				);
			}
		}
	}

	const body = normalizeBody(lines.filter((_, i) => !removed[i]).join("\n"));

	return {
		ok: true,
		file: { frontmatter, body, criteria, dod },
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Canonical rendering
// ---------------------------------------------------------------------------

/** Frontmatter key order in the canonical rendering. */
function frontmatterObject(
	fm: TaskFrontmatter & { id: string; rev: number },
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: fm.id,
		rev: fm.rev,
		title: fm.title,
		type: fm.type,
		priority: fm.priority,
	};
	if (fm.size !== null) out.size = fm.size;
	if (fm.labels.length > 0) out.labels = fm.labels;
	if (fm.parent !== null) out.parent = fm.parent;
	if (fm.depends_on.length > 0) out.depends_on = fm.depends_on;
	if (fm.spike_timebox !== null) out.spike_timebox = fm.spike_timebox;
	if (fm.requires_resources.length > 0) {
		out.requires_resources = fm.requires_resources;
	}
	if (fm.execution_target !== "local")
		out.execution_target = fm.execution_target;
	if (fm.local_staging_resources.length > 0) {
		out.local_staging_resources = fm.local_staging_resources;
	}
	if (fm.workload_secret_grants.length > 0) {
		out.workload_secret_grants = fm.workload_secret_grants;
	}
	// Defaults are omitted so files stay quiet.
	if (fm.require_review) out.require_review = true;
	if (fm.created !== null) out.created = fm.created;
	if (fm.source !== "human") out.source = fm.source;
	if (fm.split_from !== null) out.split_from = fm.split_from;
	if (fm.lifetime_def !== null) out.lifetime_def = fm.lifetime_def;
	if (fm.blocked_reason !== null) out.blocked_reason = fm.blocked_reason;
	if (fm.draft_prompt !== null) out.draft_prompt = fm.draft_prompt;
	if (fm.after_expansion !== "ready") out.after_expansion = fm.after_expansion;
	if (fm.ready_mode !== "automatic") out.ready_mode = fm.ready_mode;
	if (fm.capture_id != null) out.capture_id = fm.capture_id;
	if (fm.owns.length > 0) out.owns = fm.owns;
	if (fm.model_tier !== null) out.model_tier = fm.model_tier;
	if (fm.discovered_from !== null) out.discovered_from = fm.discovered_from;
	if (fm.discovery_key != null) out.discovery_key = fm.discovery_key;
	if (fm.reopen_when.length > 0) out.reopen_when = fm.reopen_when;
	return out;
}

function renderFrontmatter(
	fm: TaskFrontmatter & { id: string; rev: number },
): string {
	const doc = new Document(frontmatterObject(fm));
	if (isMap(doc.contents)) {
		for (const item of doc.contents.items) {
			if (isSeq(item.value)) item.value.flow = true;
		}
	}
	return doc.toString();
}

function canonicalCheck(check: DoDCheck): Record<string, unknown> {
	const timeout = check.timeout !== undefined ? { timeout: check.timeout } : {};
	if ("run" in check) {
		return { run: check.run, expect_exit: check.expect_exit, ...timeout };
	}
	if ("files_exist" in check) {
		return { files_exist: check.files_exist, ...timeout };
	}
	return { diff_against_base: check.diff_against_base, ...timeout };
}

function renderDoD(dod: DefinitionOfDone): string {
	return stringifyYaml({
		verifier: dod.verifier,
		checks: dod.checks.map(canonicalCheck),
	});
}

/** Render canonical task-file markdown: frontmatter (fixed key order, empty fields omitted), body, criteria, verification. */
export function renderTaskFile(
	file: TaskFile & { frontmatter: { id: string; rev: number } },
): string {
	const parts: string[] = [`---\n${renderFrontmatter(file.frontmatter)}---`];

	const body = normalizeBody(file.body);
	if (body.length > 0) parts.push(body);

	if (file.criteria.length > 0) {
		const items = file.criteria.map((c) =>
			`- ${c.text.replace(/\r?\n/g, " ")}`.trimEnd(),
		);
		parts.push(`## Acceptance Criteria\n\n${items.join("\n")}`);
	}

	if (file.dod) {
		parts.push(
			`## Verification checks\n\n\`\`\`verification\n${renderDoD(file.dod)}\`\`\``,
		);
	}

	return `${parts.join("\n\n")}\n`;
}
