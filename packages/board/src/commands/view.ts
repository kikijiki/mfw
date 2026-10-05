import { CliError, type Command, UsageError } from "./types.ts";
import { views } from "./views/index.ts";

export const view: Command = {
	name: "view",
	usage: views.map((v) => v.usage),
	async run(ctx, args) {
		const name = args.positional[0];
		if (!name) throw new UsageError();
		const v = views.find((x) => x.name === name);
		if (!v) {
			throw new CliError(
				`unknown view '${name}' (valid views: ${views.map((x) => x.name).join(", ")})`,
				2,
			);
		}
		await v.run(ctx, { ...args, positional: args.positional.slice(1) });
	},
};
