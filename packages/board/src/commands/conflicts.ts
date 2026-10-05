import {
	effectiveDependencies,
	findOwnershipConflictsExempt,
	inertExemptionPairs,
	isLive,
	isTerminal,
} from "@mfw/board-core";
import { CliError, type Command } from "./types.ts";
import {
	allDocuments,
	loadExemptions,
	optionalType,
	requireNoPositional,
	requireOwnership,
	requireStatusClasses,
	statusValueOf,
} from "./workflow-shared.ts";

export const conflicts: Command = {
	name: "conflicts",
	usage: [
		"conflicts [--type <type>] [--json]   (live documents whose file scopes overlap with nothing ordering them; exit 1 if any)",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const { config } = ctx.project;
		requireStatusClasses(config);
		const only = optionalType(config, args.type);
		const types = requireOwnership(config, only);
		const docs = await allDocuments(ctx);
		const deps = effectiveDependencies(config, docs);
		const found: { a: string; b: string; patterns: [string, string][] }[] = [];
		const inert: { cards: [string, string]; ruling?: string }[] = [];
		let liveCount = 0;
		for (const t of types) {
			const field = config.types[t]?.ownership?.field as string;
			const ex = await loadExemptions(ctx, t, docs);
			const mine = docs.filter((d) => d.type === t);
			const live = mine.filter((d) =>
				isLive(config, t, statusValueOf(config, d)),
			);
			liveCount += live.length;
			const nodes = live.map((d) => ({
				id: d.id,
				owns: (d.fields[field] as string[] | undefined) ?? [],
				dependsOn: deps.get(d.id) ?? [],
			}));
			found.push(...findOwnershipConflictsExempt(nodes, ex));
			if (ex) {
				const open = new Set(
					mine
						.filter((d) => !isTerminal(config, t, statusValueOf(config, d)))
						.map((d) => d.id),
				);
				inert.push(...inertExemptionPairs(ex, open));
			}
		}
		if (ctx.json) {
			console.log(
				JSON.stringify({
					ok: found.length === 0,
					conflicts: found,
					inertExemptions: inert,
				}),
			);
		} else {
			if (inert.length > 0) {
				console.log(
					`${inert.length} exemption pair(s) protect nothing (a task has finished); delete:`,
				);
				for (const p of inert) console.log(`  ${p.cards[0]} <-> ${p.cards[1]}`);
			}
			for (const c of found) {
				for (const [pa, pb] of c.patterns)
					console.log(`${c.a} <-> ${c.b}: ${pa} ~ ${pb}`);
			}
			if (found.length === 0) {
				console.log(
					`ok: no unordered overlaps among ${liveCount} live documents`,
				);
			}
		}
		if (found.length > 0) throw new CliError("", 1);
	},
};
