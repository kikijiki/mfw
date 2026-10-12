import { type ConflictReport, ownershipConflicts } from "@mfw/board-core";
import { CliError, type Command } from "./types.ts";
import {
	allDocuments,
	optionalType,
	requireNoPositional,
	requireOwnership,
	requireStatusClasses,
} from "./workflow-shared.ts";

export const conflicts: Command = {
	name: "conflicts",
	usage: [
		"conflicts [--type <type>] [--json]   (live documents whose file scopes overlap with nothing ordering them; `check` fails on them)",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const { config } = ctx.project;
		requireStatusClasses(config);
		const only = optionalType(config, args.type);
		const types = requireOwnership(config, only);
		const docs = await allDocuments(ctx);
		let report: ConflictReport;
		try {
			report = await ownershipConflicts(ctx.project.root, config, docs, types);
		} catch (e) {
			throw new CliError(e instanceof Error ? e.message : String(e), 3);
		}
		const { found, inert, liveCount } = report;
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
	},
};
