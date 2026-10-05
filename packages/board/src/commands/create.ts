import { parseFieldArgs, printDocument } from "@mfw/board-core";
import { resolveType } from "./shared.ts";
import type { Command } from "./types.ts";

export const create: Command = {
	name: "create",
	usage: [
		"create [--type <type>] [--id <id>] [--body <text>] [field=value ...]",
	],
	async run(ctx, args) {
		const type = resolveType(ctx, args);
		const fields = parseFieldArgs(ctx.project.config, type, args.fieldArgs);
		const doc = await ctx.project.store.createDocument(type, {
			id: args.id,
			fields,
			body: args.body,
		});
		printDocument(doc);
	},
};
