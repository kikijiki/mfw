import {
	applyFieldOpDetailed,
	documentToJson,
	type FieldOp,
	type FieldSpec,
	printDocument,
} from "@mfw/board-core";
import { resolveDocumentType } from "./shared.ts";
import {
	CliError,
	type CommandContext,
	type ParsedArgs,
	UsageError,
} from "./types.ts";

/** The `<id> <field>` pair at the front of a field-op command's tokens (read
 * from `args.rest`, which keeps `=`/`~` tokens in place), plus the type. */
export async function target(
	ctx: CommandContext,
	args: ParsedArgs,
): Promise<{
	type: string;
	id: string;
	field: string;
	spec: FieldSpec;
	tail: string[];
}> {
	const [id, field, ...tail] = args.rest;
	if (!id || !field) throw new UsageError();
	const type = await resolveDocumentType(ctx, args, id);
	const spec = ctx.project.config.types[type]?.fields[field];
	if (!spec) {
		throw new CliError(`type '${type}' has no field '${field}'`);
	}
	return { type, id, field, spec, tail };
}

/** Run one op and print the updated document (or its JSON); `showItemId`
 * additionally reports the checklist item the op created. */
export async function runFieldOp(
	ctx: CommandContext,
	args: ParsedArgs,
	type: string,
	id: string,
	op: FieldOp,
	showItemId = false,
): Promise<void> {
	const r = await applyFieldOpDetailed(
		ctx.project.store,
		ctx.project.config,
		type,
		id,
		op,
		{ baseRev: args.baseRev },
	);
	if (ctx.json) {
		console.log(
			JSON.stringify({
				...documentToJson(r.doc),
				...(showItemId ? { itemId: r.itemId } : {}),
			}),
		);
		return;
	}
	printDocument(r.doc);
	if (showItemId && r.itemId) console.log(`added ${r.itemId}`);
}

export function parseJson(raw: string, what: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new CliError(`${what} must be valid JSON`);
	}
}

export function parseIndex(raw: string | undefined, what: string): number {
	const n = Number(raw);
	if (raw === undefined || raw === "" || !Number.isInteger(n)) {
		throw new CliError(`${what} must be an integer`);
	}
	return n;
}
