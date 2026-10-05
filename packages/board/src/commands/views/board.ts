import { statusClassOf } from "@mfw/board-core";
import type { CommandContext, ParsedArgs } from "../types.ts";
import {
	allDocuments,
	checkUnder,
	descendantsOf,
	optionalType,
	parseFormat,
	renderTable,
	statusValueOf,
} from "../workflow-shared.ts";
import type { View } from "./index.ts";

async function run(ctx: CommandContext, args: ParsedArgs): Promise<void> {
	const config = ctx.project.config;
	const format = parseFormat(args.format ?? (ctx.json ? "json" : undefined));
	const type = optionalType(config, args.type);
	const docs = await allDocuments(ctx);
	checkUnder(config, docs, args.under);
	const within =
		args.under !== undefined
			? descendantsOf(config, docs, args.under)
			: undefined;
	const counts = new Map<string, number>();
	let total = 0;
	for (const d of docs) {
		if (type !== undefined && d.type !== type) continue;
		if (within !== undefined && !within.has(d.id)) continue;
		const key = `${d.type}\t${statusValueOf(config, d)}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		total++;
	}
	const withClass = Object.values(config.types).some((t) => t.workflow);
	const rows: (string | number)[][] = [...counts]
		.map(([k, n]) => {
			const [t, s] = k.split("\t") as [string, string];
			const row: (string | number)[] = [t, s || "-"];
			if (withClass) row.push(statusClassOf(config, t, s));
			row.push(n);
			return row;
		})
		.sort((a, b) => `${a[0]}\t${a[1]}`.localeCompare(`${b[0]}\t${b[1]}`));
	const total_row: (string | number)[] = ["total", ""];
	if (withClass) total_row.push("");
	total_row.push(total);
	rows.push(total_row);
	const columns = withClass
		? ["type", "status", "class", "count"]
		: ["type", "status", "count"];
	console.log(renderTable({ columns, rows }, format));
}

export const boardView: View = {
	name: "board",
	usage: "view board [--type <type>] [--under <id>] [--format md|tsv|json]",
	run,
};
