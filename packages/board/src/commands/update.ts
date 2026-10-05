import { parseFieldArgs, printDocument } from "@mfw/board-core";
import { resolveDocumentType } from "./shared.ts";
import { type Command, UsageError } from "./types.ts";

export const update: Command = {
	name: "update",
	usage: [
		"update [--type <type>] <id> [--base-rev <n>] [--body <text>] [field=value ...]",
	],
	async run(ctx, args) {
		const id = args.positional[0];
		if (!id) throw new UsageError();
		const type = await resolveDocumentType(ctx, args, id);
		const fields = parseFieldArgs(ctx.project.config, type, args.fieldArgs);
		const doc = await ctx.project.store.updateDocument(
			type,
			id,
			{ fields, body: args.body },
			{ baseRev: args.baseRev },
		);
		printDocument(doc);
	},
};
