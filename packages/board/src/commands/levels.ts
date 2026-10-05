import { computeLevels } from "@mfw/board-core";
import type { Command } from "./types.ts";
import {
	allDocuments,
	checkUnder,
	descendantsOf,
	parseFormat,
	renderTable,
	requireNoPositional,
	statusFieldOf,
	statusValueOf,
} from "./workflow-shared.ts";

export const levels: Command = {
	name: "levels",
	usage: ["levels [--under <id>] [--format md|tsv|json]"],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const config = ctx.project.config;
		const format = parseFormat(args.format ?? (ctx.json ? "json" : undefined));
		const docs = await allDocuments(ctx);
		checkUnder(config, docs, args.under);
		const within =
			args.under !== undefined
				? descendantsOf(config, docs, args.under)
				: undefined;
		const lv = computeLevels(config, docs);
		const seen = new Set<string>();
		const rows = docs
			.filter((d) => !seen.has(d.id) && seen.add(d.id))
			.filter((d) => within === undefined || within.has(d.id))
			.map((d) => {
				let title = d.fields.title;
				if (typeof title !== "string") {
					const sf = statusFieldOf(config, d.type);
					title =
						Object.entries(d.fields).find(
							([k, v]) => k !== sf && typeof v === "string" && v !== "",
						)?.[1] ?? "";
				}
				return {
					id: d.id,
					level: lv.get(d.id) ?? 0,
					status: statusValueOf(config, d),
					title: title as string,
				};
			})
			.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
		console.log(
			renderTable(
				{
					columns: ["id", "level", "status", "title"],
					rows: rows.map((r) => [r.id, r.level, r.status, r.title]),
				},
				format,
			),
		);
	},
};
