import { z } from "zod";
import type { FieldSpec } from "./config.ts";

/**
 * The optional per-type `workflow` surface of `board.yaml`: which enum field
 * is the status, how its values classify (terminal/live/parked/queued), which
 * fields `ready` shows, and the named `transitions`. Kept in its own module so
 * `config.ts` only needs to splice `rawWorkflowShape` into its type schema and
 * call `normalizeWorkflow`. Returns error strings instead of throwing so this
 * file never has to import `BoardConfigError` (no import cycle).
 */

const FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/;
const VERB_RE = /^[a-z][a-z0-9_-]*$/;

/** Verbs a board cannot define: they collide with built-in CLI commands. */
export const RESERVED_VERBS: ReadonlySet<string> = new Set([
	"list",
	"show",
	"create",
	"update",
	"validate",
	"claim",
	"release",
	"ready",
	"levels",
	"view",
	"skill",
	"reparent",
	"repair",
	"graph",
	"plan",
	"conflicts",
	"append",
	"prepend",
	"insert",
	"remove",
	"move",
	"inc",
	"dec",
	"toggle",
	"unset",
	"check",
	"note",
	"row",
]);

const rawTransitionSchema = z
	.object({
		from: z.array(z.string().min(1)).min(1),
		to: z.string().min(1),
		arg: z.string().regex(FIELD_NAME_RE).optional(),
		date: z.string().regex(FIELD_NAME_RE).optional(),
		clear: z.array(z.string().regex(FIELD_NAME_RE)).optional(),
	})
	.strict();

const names = z.array(z.string().min(1));

/** Spread into the raw type schema (`z.object({...rawWorkflowShape})`). */
export const rawWorkflowShape = {
	statusField: z.string().regex(FIELD_NAME_RE).optional(),
	statusClasses: z
		.object({
			terminal: names.optional(),
			live: names.optional(),
			parked: names.optional(),
			queued: names.optional(),
		})
		.strict()
		.optional(),
	ready: z
		.object({
			columns: z.array(z.string().regex(FIELD_NAME_RE)).optional(),
			dependsOn: z.string().regex(FIELD_NAME_RE).optional(),
		})
		.strict()
		.optional(),
	transitions: z
		.record(z.string().regex(VERB_RE), rawTransitionSchema)
		.optional(),
	commit: z
		.object({ prefix: z.string().min(1) })
		.strict()
		.optional(),
};

export interface RawWorkflow {
	statusField?: string | undefined;
	statusClasses?:
		| {
				terminal?: string[] | undefined;
				live?: string[] | undefined;
				parked?: string[] | undefined;
				queued?: string[] | undefined;
		  }
		| undefined;
	ready?:
		| { columns?: string[] | undefined; dependsOn?: string | undefined }
		| undefined;
	transitions?: Record<string, z.infer<typeof rawTransitionSchema>> | undefined;
	commit?: { prefix: string } | undefined;
}

export interface TransitionSpec {
	from: readonly string[];
	to: string;
	/** Field receiving the REQUIRED text argument. */
	arg?: string;
	/** Field set to today's date, or to the explicit `--date`; never read from text. */
	date?: string;
	/** Fields reset to empty. */
	clear: readonly string[];
}

export interface TypeWorkflow {
	statusField: string;
	classes: {
		terminal: readonly string[];
		live: readonly string[];
		parked: readonly string[];
		queued: readonly string[];
	};
	ready: { columns: readonly string[]; dependsOn: string };
	transitions: Record<string, TransitionSpec>;
	/** `--commit` settings: message prefix (default: the type name). */
	commit: { prefix: string };
}

export type WorkflowResult =
	| { ok: true; workflow: TypeWorkflow | undefined }
	| { ok: false; error: string };

/** True when the raw type declared any workflow key at all. */
export function hasWorkflowKeys(raw: RawWorkflow): boolean {
	return (
		raw.statusField !== undefined ||
		raw.statusClasses !== undefined ||
		raw.ready !== undefined ||
		raw.transitions !== undefined ||
		raw.commit !== undefined
	);
}

export function normalizeWorkflow(
	typeName: string,
	raw: RawWorkflow,
	fields: Record<string, FieldSpec>,
	/** The board's hierarchy-managed field names, which a transition must not write. */
	hierarchy?: { parent: string; children: string },
): WorkflowResult {
	if (!hasWorkflowKeys(raw)) return { ok: true, workflow: undefined };
	const at = `type '${typeName}'`;
	const fail = (error: string): WorkflowResult => ({
		ok: false,
		error: `${at}: ${error}`,
	});

	const statusField = raw.statusField ?? "status";
	const status = fields[statusField];
	if (status?.kind !== "enum" || status.list) {
		return fail(
			`statusField '${statusField}' must name a single-valued enum field`,
		);
	}
	const values = new Set(status.values);

	const classes = {
		terminal: raw.statusClasses?.terminal ?? [],
		live: raw.statusClasses?.live ?? [],
		parked: raw.statusClasses?.parked ?? [],
		queued: raw.statusClasses?.queued ?? [],
	};
	for (const [cls, list] of Object.entries(classes)) {
		for (const v of list) {
			if (!values.has(v)) {
				return fail(
					`statusClasses.${cls}: '${v}' is not a value of '${statusField}'`,
				);
			}
		}
	}
	for (const v of classes.queued) {
		if (!classes.live.includes(v)) {
			return fail(`statusClasses.queued: '${v}' must also be in live`);
		}
	}
	const groups = ["terminal", "live", "parked"] as const;
	for (let i = 0; i < groups.length; i++) {
		for (let j = i + 1; j < groups.length; j++) {
			const a = groups[i] as (typeof groups)[number];
			const b = groups[j] as (typeof groups)[number];
			const both = classes[a].find((v) => classes[b].includes(v));
			if (both !== undefined) {
				return fail(
					`statusClasses: '${both}' is in both ${a} and ${b} (they must be disjoint)`,
				);
			}
		}
	}

	const columns = raw.ready?.columns ?? [];
	for (const c of columns) {
		if (!(c in fields)) {
			return fail(`ready.columns: '${c}' is not a declared field`);
		}
	}
	const dependsOn = raw.ready?.dependsOn ?? "depends_on";
	if (raw.ready?.dependsOn !== undefined) {
		const dep = fields[dependsOn];
		if (dep?.kind !== "ref" || !dep.list) {
			return fail(`ready.dependsOn '${dependsOn}' must name a list ref field`);
		}
	}

	const transitions: Record<string, TransitionSpec> = {};
	for (const [verb, t] of Object.entries(raw.transitions ?? {})) {
		const tat = `transitions.${verb}`;
		if (RESERVED_VERBS.has(verb)) {
			return fail(`${tat}: '${verb}' is a reserved command name`);
		}
		for (const f of t.from) {
			if (!values.has(f)) {
				return fail(`${tat}.from: '${f}' is not a value of '${statusField}'`);
			}
		}
		if (!values.has(t.to)) {
			return fail(`${tat}.to: '${t.to}' is not a value of '${statusField}'`);
		}
		for (const [key, f] of [
			["arg", t.arg],
			["date", t.date],
		] as const) {
			if (f === undefined) continue;
			if (!(f in fields)) {
				return fail(`${tat}.${key}: '${f}' is not a declared field`);
			}
			if (f === statusField) {
				return fail(`${tat}.${key}: cannot be the status field`);
			}
			if (hierarchy && (f === hierarchy.parent || f === hierarchy.children)) {
				return fail(
					`${tat}.${key}: '${f}' is managed by the hierarchy and cannot be written by a transition`,
				);
			}
			const spec = fields[f] as FieldSpec;
			if (key === "arg") {
				const plain =
					!("list" in spec && spec.list) &&
					(spec.kind === "enum" ||
						(spec.kind === "scalar" && spec.type === "string"));
				if (!plain) {
					return fail(
						`${tat}.arg: '${f}' must be a single-valued string (or enum) field to receive the argument text`,
					);
				}
			} else if (
				!(
					spec.kind === "scalar" &&
					!spec.list &&
					(spec.type === "date" || spec.type === "string")
				)
			) {
				return fail(
					`${tat}.date: '${f}' must be a single-valued date (or string) field`,
				);
			}
		}
		for (const f of t.clear ?? []) {
			if (!(f in fields)) {
				return fail(`${tat}.clear: '${f}' is not a declared field`);
			}
			if (f === statusField) {
				return fail(`${tat}.clear: cannot clear the status field`);
			}
			if (hierarchy && (f === hierarchy.parent || f === hierarchy.children)) {
				return fail(
					`${tat}.clear: '${f}' is managed by the hierarchy and cannot be cleared by a transition`,
				);
			}
			const spec = fields[f] as FieldSpec;
			const hasDefault = "default" in spec && spec.default !== undefined;
			if (!spec.optional && !hasDefault && !spec.requiredWhen) {
				return fail(
					`${tat}.clear: '${f}' is required (no default, not optional), so clearing it would make the document invalid`,
				);
			}
		}
		transitions[verb] = {
			from: t.from,
			to: t.to,
			...(t.arg !== undefined ? { arg: t.arg } : {}),
			...(t.date !== undefined ? { date: t.date } : {}),
			clear: t.clear ?? [],
		};
	}

	return {
		ok: true,
		workflow: {
			statusField,
			classes,
			ready: { columns, dependsOn },
			transitions,
			commit: { prefix: raw.commit?.prefix ?? typeName },
		},
	};
}
