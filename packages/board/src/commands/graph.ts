import { dependencyGraph, renderDot, renderMermaid } from "@mfw/board-core";
import { CliError, type Command } from "./types.ts";
import {
	allDocuments,
	checkUnder,
	requireNoPositional,
	requireStatusClasses,
} from "./workflow-shared.ts";

export const graph: Command = {
	name: "graph",
	usage: [
		"graph [--under <id>] [--format mermaid|dot|json] [--all]   (dependency graph; arrows run dependency -> dependent)",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const { config } = ctx.project;
		requireStatusClasses(config);
		const format = args.format ?? (ctx.json ? "json" : "mermaid");
		if (!["mermaid", "dot", "json"].includes(format)) {
			throw new CliError(
				`unknown --format '${format}' (mermaid, dot, json)`,
				2,
			);
		}
		const docs = await allDocuments(ctx);
		checkUnder(config, docs, args.under);
		const g = dependencyGraph(config, docs, {
			...(args.under !== undefined ? { under: args.under } : {}),
			...(args.all ? { all: true } : {}),
		});
		if (format === "json") console.log(JSON.stringify(g));
		else console.log(format === "dot" ? renderDot(g) : renderMermaid(g));
	},
};
