import { formatId } from "@mfw/board-core";
import { CliError, type CommandContext, type ParsedArgs } from "./types.ts";

/**
 * `--type` if given; else `task` when the board has such a type, else the only
 * type when there is exactly one, else an error asking for `--type`.
 */
export function resolveType(ctx: CommandContext, args: ParsedArgs): string {
	const types = Object.keys(ctx.project.config.types);
	if (args.type !== undefined) {
		if (!types.includes(args.type)) {
			throw new CliError(
				`unknown type '${args.type}' (board types: ${types.join(", ") || "none"})`,
			);
		}
		return args.type;
	}
	if (types.includes("task")) return "task";
	if (types.length === 1) return types[0] as string;
	throw new CliError(
		`this board has ${types.length === 0 ? "no types" : `several types (${types.join(", ")})`} and none is named 'task'; pass --type <type>`,
	);
}

/**
 * The type of the existing document `id`: `--type` if given, else the one type
 * (among `among`, default every type) that holds a document with that id. An id
 * several types hold (an `inherit` type shares its source's ids) resolves to
 * the board's default type when that is one of them. With no match it falls
 * back to `resolveType`, so a missing id keeps its usual "not found" error.
 */
export async function resolveDocumentType(
	ctx: CommandContext,
	args: ParsedArgs,
	id: string,
	among?: readonly string[],
): Promise<string> {
	if (args.type !== undefined) return resolveType(ctx, args);
	const candidates = among ?? Object.keys(ctx.project.config.types);
	const hits: string[] = [];
	for (const t of candidates) {
		if (await ctx.project.store.readDocument(t, id)) hits.push(t);
	}
	if (hits.length === 1) return hits[0] as string;
	if (hits.length > 1) {
		let preferred: string | undefined;
		try {
			preferred = resolveType(ctx, args);
		} catch {
			// no default type: the error below says what to do
		}
		if (preferred !== undefined && hits.includes(preferred)) return preferred;
		throw new CliError(
			`'${id}' exists in several types (${hits.join(", ")}); pass --type <type>`,
			2,
		);
	}
	const type = resolveType(ctx, args);
	const hint = await didYouMean(ctx, id, candidates);
	if (hint) throw new CliError(`${type} '${id}' not found${hint}`);
	return type;
}

/**
 * A hint for a bare number typed instead of a keyed id: the keyed ids
 * (`ABC-493`, `ABC-ADR-0012`) that exist among `among` types for `id`, as
 * " (did you mean ...?)", or "" when nothing matches.
 */
export async function didYouMean(
	ctx: CommandContext,
	id: string,
	among?: readonly string[],
): Promise<string> {
	if (!/^\d+$/.test(id)) return "";
	const found: string[] = [];
	for (const t of among ?? Object.keys(ctx.project.config.types)) {
		const spec = ctx.project.config.types[t]?.id;
		if (spec?.strategy !== "own-sequence") continue;
		const candidate = formatId(spec.key, Number(id), spec.suffix, spec.pad);
		if (
			!found.includes(candidate) &&
			(await ctx.project.store.readDocument(t, candidate))
		) {
			found.push(candidate);
		}
	}
	return found.length > 0 ? ` (did you mean ${found.join(" or ")}?)` : "";
}
