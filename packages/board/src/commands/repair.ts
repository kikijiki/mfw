import { CliError, type Command } from "./types.ts";
import { requireNoPositional } from "./workflow-shared.ts";

/** `repair`: rebuild every parent's `children` from the children's `parent`. */
export const repair: Command = {
	name: "repair",
	usage: [
		"repair [--json]   (rebuild each parent's children list from the parent fields)",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		if (!ctx.project.config.hierarchy) {
			throw new CliError(
				"this board declares no hierarchy; nothing to repair",
				2,
			);
		}
		const changed = await ctx.project.store.repairHierarchy();
		if (ctx.json) {
			console.log(JSON.stringify({ repaired: changed }));
			return;
		}
		for (const c of changed) {
			console.log(
				`repaired ${c.type} ${c.id}: children [${c.before.join(", ")}] -> [${c.after.join(", ")}]`,
			);
		}
		if (changed.length === 0) console.log("nothing to repair");
	},
};
