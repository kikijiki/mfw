import {
	effectiveDependencies,
	impactOf,
	matchesQueryFilters,
	parseQueryFilters,
	readyDocuments,
} from "@mfw/board-core";
import type { Command } from "./types.ts";
import {
	allDocuments,
	checkUnder,
	optionalType,
	requireNoPositional,
	requireStatusClasses,
	statusValueOf,
} from "./workflow-shared.ts";

function show(v: unknown): string {
	if (Array.isArray(v)) return v.join(",");
	return v === undefined || v === null || v === "" ? "-" : String(v);
}

export const ready: Command = {
	name: "ready",
	usage: [
		"ready [--type <type>] [--under <id>] [--json] [--unblocks] [field=a|b ...] [field~a|b ...]",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const config = ctx.project.config;
		requireStatusClasses(config);
		const type = optionalType(config, args.type);
		const docs = await allDocuments(ctx);
		checkUnder(config, docs, args.under);
		const opts = args.under !== undefined ? { under: args.under } : {};

		const deps = effectiveDependencies(config, docs);
		const impact = impactOf(config, docs);
		const filters = parseQueryFilters(args.fieldArgs);
		const found = readyDocuments(config, docs, opts).filter(
			(d) =>
				(type === undefined || d.type === type) &&
				matchesQueryFilters(d, filters),
		);
		if (ctx.json) {
			console.log(
				JSON.stringify(
					found.map((d) => ({
						id: d.id,
						type: d.type,
						status: statusValueOf(config, d),
						dependsOn: deps.get(d.id) ?? [],
						unblocks: impact.get(d.id)?.unblocks ?? 0,
						chain: impact.get(d.id)?.height ?? 0,
						fields: d.fields,
						columns: Object.fromEntries(
							(config.types[d.type]?.workflow?.ready.columns ?? []).map((c) => [
								c,
								d.fields[c] ?? null,
							]),
						),
					})),
				),
			);
			return;
		}
		for (const d of found) {
			const cols = config.types[d.type]?.workflow?.ready.columns ?? [];
			const dep = deps.get(d.id) ?? [];
			let line = `${d.id} ${statusValueOf(config, d)} deps: ${dep.length ? dep.join(",") : "-"}`;
			if (args.unblocks)
				line += ` unblocks: ${impact.get(d.id)?.unblocks ?? 0}`;
			if (cols.length > 0) {
				line += ` | ${cols.map((c) => show(d.fields[c])).join(" ")}`;
			}
			console.log(line);
		}
	},
};
