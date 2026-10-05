import {
	documentToJson,
	matchesQueryFilters,
	parseQueryFilters,
} from "@mfw/board-core";
import { resolveType } from "./shared.ts";
import type { Command } from "./types.ts";

export const list: Command = {
	name: "list",
	usage: ["list [--type <type>] [--json] [field=a|b ...] [field~a|b ...]"],
	async run(ctx, args) {
		const type = resolveType(ctx, args);
		const filters = parseQueryFilters(args.fieldArgs);
		const docs = (await ctx.project.store.listDocuments(type)).filter((d) =>
			matchesQueryFilters(d, filters),
		);
		if (ctx.json) console.log(JSON.stringify(docs.map(documentToJson)));
		else for (const doc of docs) console.log(`${doc.id}\t${doc.type}`);
	},
};
