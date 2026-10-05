import type { OwnershipExemptions } from "@mfw/board-core";
import { planParallel } from "@mfw/board-core";
import type { Command } from "./types.ts";
import {
	allDocuments,
	checkUnder,
	loadExemptions,
	requireNoPositional,
	requireStatusClasses,
} from "./workflow-shared.ts";

export const plan: Command = {
	name: "plan",
	usage: [
		"plan [--under <id>] [--max <n>] [--json]   (a conflict-free batch of ready documents to start together)",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const { config } = ctx.project;
		requireStatusClasses(config);
		const docs = await allDocuments(ctx);
		checkUnder(config, docs, args.under);
		const exemptions = new Map<string, OwnershipExemptions>();
		for (const [name, t] of Object.entries(config.types)) {
			const ex = t.ownership
				? await loadExemptions(ctx, name, docs)
				: undefined;
			if (ex) exemptions.set(name, ex);
		}
		const result = planParallel(config, docs, {
			...(args.under !== undefined ? { under: args.under } : {}),
			...(args.max !== undefined ? { max: args.max } : {}),
			exemptions: (t) => exemptions.get(t),
		});
		if (ctx.json) {
			console.log(JSON.stringify(result));
			return;
		}
		if (result.picked.length === 0) console.log("nothing to start");
		else {
			console.log(`start together (${result.picked.length}):`);
			for (const p of result.picked) {
				const scope = p.scope.length > 0 ? ` scope: ${p.scope.join(", ")}` : "";
				console.log(
					`  ${p.id}  unblocks ${p.unblocks}, chain ${p.height}${scope}${p.title ? `  ${p.title}` : ""}`,
				);
			}
		}
		if (result.skipped.length > 0) {
			console.log("skipped:");
			for (const s of result.skipped) console.log(`  ${s.id}: ${s.reason}`);
		}
		if (result.blockers.length > 0) {
			console.log("blocking the most work:");
			for (const b of result.blockers) {
				const next =
					b.next.length > 0
						? `; ready once it finishes: ${b.next.join(", ")}`
						: "";
				console.log(`  ${b.id}: ${b.unblocks} waiting${next}`);
			}
		}
		if (result.inProgress.length > 0) {
			console.log(`in progress: ${result.inProgress.join(", ")}`);
		}
		if (result.toClose.length > 0) {
			console.log(
				`ready to close (all children finished): ${result.toClose.join(", ")}`,
			);
		}
	},
};
