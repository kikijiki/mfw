import { normalizeOwnsPattern, validateOwnsPattern } from "@mfw/board";
import type {
	Priority,
	TaskSize,
	TaskSource,
	TaskStatus,
	TaskType,
	VerifierKind,
} from "@mfw/core/types";
import { z } from "zod";

/**
 * Task frontmatter vocabulary: the types/schemas every daemon file that used
 * to import them from `@mfw/core/taskfile` now imports from here instead.
 *
 * `@mfw/board-core` already validates every field `.mfw/board.yaml` declares
 * as a scalar/enum/ref against its declared kind — a `BoardDocument.fields`
 * record reaching this module already has the right shape for most fields.
 * Four fields are declared `type: json` in `.mfw/board.yaml` (board-core only
 * confirms "valid YAML", not their actual shape): `requires_resources`,
 * `local_staging_resources`, `reopen_when`, `verification`. Two more
 * (`owns`, `workload_secret_grants`) are plain string lists at the board-core
 * level but carry real validation/normalization rules of their own. This
 * module re-validates exactly those six through the zod schemas below, via
 * `materializeTaskFrontmatter`.
 *
 * No parsing/rendering logic lives here — `@mfw/board-core` does that
 * generically now. This is vocabulary only, same spirit as `@mfw/core/types.ts`.
 */

export const MODEL_TIERS = ["light", "standard", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const VERIFIERS = [
	"deterministic",
	"llm-judge",
] as const satisfies readonly VerifierKind[];

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
// Resources
// ---------------------------------------------------------------------------

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

export function rejectDuplicateResources(
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

const taskResourceRequirementsSchema = z
	.array(TaskResourceRequirementSchema)
	.superRefine(rejectDuplicateResources);
const localStagingResourceRequirementsSchema = z
	.array(LocalStagingResourceRequirementSchema)
	.superRefine(rejectDuplicateResources);

// ---------------------------------------------------------------------------
// Reopen conditions
// ---------------------------------------------------------------------------

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

export type RunCondition = Extract<ReopenCondition, { run: string }>;

export function isRunCondition(c: ReopenCondition): c is RunCondition {
	return "run" in c;
}

// ---------------------------------------------------------------------------
// Owns / workload secrets
// ---------------------------------------------------------------------------

/** `owns` patterns: repository-relative, validated by `@mfw/board`'s ownership module. */
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

/** Machine-side workload grant ids; never credential values. */
export const WorkloadSecretGrantsSchema = z.array(
	z.string().regex(/^[A-Za-z0-9._-]+$/),
);

// ---------------------------------------------------------------------------
// TaskFrontmatter
// ---------------------------------------------------------------------------

export interface TaskFrontmatter {
	id: string;
	rev: number;
	title: string;
	status: TaskStatus;
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
	capture_id: string | null;
	owns: string[];
	model_tier: ModelTier | null;
	discovered_from: string | null;
	discovery_key: string | null;
	reopen_when: ReopenCondition[];
	/** The Definition of Done. A real frontmatter field now, not a fenced body
	 * block — see `.mfw/board.yaml`'s comment on this field. */
	verification: VerificationPlan | null;
}

/** Fields `@mfw/board-core` validates only as "valid YAML" (`type: json` in
 * `.mfw/board.yaml`), plus two string-list fields with extra validation of
 * their own — these are the only fields this function does real work on. */
function reparse<T>(
	schema: z.ZodType<T>,
	value: unknown,
	field: string,
	id: string,
): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new Error(
			`task ${id}: field '${field}' is invalid: ${result.error.issues.map((i) => i.message).join("; ")}`,
		);
	}
	return result.data;
}

/**
 * Turn a `BoardDocument.fields` record (already structurally validated by
 * `@mfw/board-core` against `.mfw/board.yaml`) into a fully-typed
 * `TaskFrontmatter`, the shape the rest of the daemon reads. The six fields
 * `@mfw/board-core` doesn't deeply validate are re-validated here; anything
 * that fails at this point is genuinely malformed, same severity as any other
 * parse failure.
 */
export function materializeTaskFrontmatter(
	fields: Record<string, unknown>,
	id: string,
	rev: number,
): TaskFrontmatter {
	return {
		id,
		rev,
		title: fields.title as string,
		status: fields.status as TaskStatus,
		type: fields.type as TaskType,
		priority: fields.priority as Priority,
		size: (fields.size as TaskSize | null) ?? null,
		labels: (fields.labels as string[] | undefined) ?? [],
		parent: (fields.parent as string | null) ?? null,
		depends_on: (fields.depends_on as string[] | undefined) ?? [],
		spike_timebox: (fields.spike_timebox as string | null) ?? null,
		requires_resources: reparse(
			taskResourceRequirementsSchema,
			fields.requires_resources ?? [],
			"requires_resources",
			id,
		),
		execution_target:
			(fields.execution_target as string | undefined) ?? "local",
		local_staging_resources: reparse(
			localStagingResourceRequirementsSchema,
			fields.local_staging_resources ?? [],
			"local_staging_resources",
			id,
		),
		workload_secret_grants: reparse(
			WorkloadSecretGrantsSchema,
			fields.workload_secret_grants ?? [],
			"workload_secret_grants",
			id,
		),
		require_review: (fields.require_review as boolean | undefined) ?? false,
		created: (fields.created as string | null) ?? null,
		source: (fields.source as TaskSource | undefined) ?? "human",
		split_from: (fields.split_from as string | null) ?? null,
		lifetime_def: (fields.lifetime_def as string | null) ?? null,
		blocked_reason: (fields.blocked_reason as string | null) ?? null,
		draft_prompt: (fields.draft_prompt as string | null) ?? null,
		after_expansion:
			(fields.after_expansion as "backlog" | "ready" | undefined) ?? "ready",
		ready_mode:
			(fields.ready_mode as "automatic" | "manual" | undefined) ?? "automatic",
		capture_id: (fields.capture_id as string | null) ?? null,
		owns: reparse(OwnsSchema, fields.owns ?? [], "owns", id),
		model_tier: (fields.model_tier as ModelTier | null) ?? null,
		discovered_from: (fields.discovered_from as string | null) ?? null,
		discovery_key: (fields.discovery_key as string | null) ?? null,
		reopen_when: reparse(
			z.array(ReopenConditionSchema),
			fields.reopen_when ?? [],
			"reopen_when",
			id,
		),
		verification: reparse(
			VerificationPlanSchema.nullable(),
			fields.verification ?? null,
			"verification",
			id,
		),
	};
}

/**
 * The inverse of `materializeTaskFrontmatter`: flatten a (possibly partial,
 * for a patch/update) `TaskFrontmatter`-shaped object back into the plain
 * `Record<string, unknown>` `BoardStore.updateDocument`/`createDocument`
 * expect. Field names already match `.mfw/board.yaml` 1:1; this exists so the
 * boundary is explicit and typed rather than a bare cast, and so the four
 * `type: json` fields round-trip as plain JSON values.
 */
export function dematerializeTaskFields(
	fm: Partial<Omit<TaskFrontmatter, "id" | "rev">>,
): Record<string, unknown> {
	// Every value here already came out of a zod `.parse()` or a plain literal
	// (string/number/boolean/null/array/plain object) — nothing needs cloning
	// or unwrapping to become JSON-serializable, this is just an explicit,
	// typed boundary instead of a bare cast.
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fm)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}
