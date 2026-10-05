import { documentToJson, HierarchyError, printDocument } from "@mfw/board-core";
import { resolveDocumentType } from "./shared.ts";
import { CliError, type Command, UsageError } from "./types.ts";

export const reparent: Command = {
	name: "reparent",
	usage: ["reparent [--type <type>] [--json] <id> <parentId|->"],
	async run(ctx, args) {
		const [id, parentId, extra] = args.positional;
		if (!id || !parentId || extra !== undefined) throw new UsageError();
		const type = await resolveDocumentType(ctx, args, id);
		try {
			const doc = await ctx.project.store.setParent(
				type,
				id,
				parentId === "-" ? null : parentId,
			);
			if (ctx.json) console.log(JSON.stringify(documentToJson(doc)));
			else printDocument(doc);
		} catch (e) {
			if (e instanceof HierarchyError) {
				throw new CliError(`reparent failed (${e.code}): ${e.message}`, 1);
			}
			throw e;
		}
	},
};
