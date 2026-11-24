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
			ctx.out(JSON.stringify({ repaired: changed }));
			return;
		}
		for (const c of changed) {
			ctx.out(
				`repaired ${c.type} ${c.id}: children [${c.before.join(", ")}] -> [${c.after.join(", ")}]`,
			);
		}
		if (changed.length === 0) ctx.out("nothing to repair");
	},
};
