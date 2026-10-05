import { documentToJson, printDocument } from "@mfw/board-core";
import { resolveDocumentType } from "./shared.ts";
import { CliError, type Command, UsageError } from "./types.ts";

export const show: Command = {
	name: "show",
	usage: ["show [--type <type>] [--json] <id>"],
	async run(ctx, args) {
		const id = args.positional[0];
		if (!id) throw new UsageError();
		const type = await resolveDocumentType(ctx, args, id);
		const doc = await ctx.project.store.readDocument(type, id);
		if (!doc) throw new CliError(`${type} '${id}' not found`);
		if (ctx.json) console.log(JSON.stringify(documentToJson(doc)));
		else printDocument(doc);
	},
};
