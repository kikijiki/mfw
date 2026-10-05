import { runFieldOp } from "./field-op-shared.ts";
import { resolveDocumentType } from "./shared.ts";
import { type Command, UsageError } from "./types.ts";

export const note: Command = {
	name: "note",
	usage: [
		"note [--type <type>] <id> [--section <name>] <text...> [--base-rev <n>] [--json]   (timestamped entry; default section Progress)",
	],
	async run(ctx, args) {
		const [id, ...text] = args.rest;
		if (!id || text.length === 0) throw new UsageError();
		await runFieldOp(ctx, args, await resolveDocumentType(ctx, args, id), id, {
			op: "note",
			text: text.join(" "),
			section: args.section,
		});
	},
};
