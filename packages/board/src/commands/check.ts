import type { FieldOp } from "@mfw/board-core";
import { runFieldOp, target } from "./field-op-shared.ts";
import { type Command, UsageError } from "./types.ts";

export const check: Command = {
	name: "check",
	usage: [
		"check [--type <type>] <id> <field> add <text> | toggle <sel> | done <sel> | undone <sel> | remove <sel> | edit <sel> <text>",
		"      (checklist field; <sel> is an item id like c3 or a unique text prefix; also --base-rev <n>, --json)",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		const [verb, ...more] = t.tail;
		if (!verb || more.length === 0) throw new UsageError();
		const field = t.field;
		let op: FieldOp;
		switch (verb) {
			case "add":
				op = { op: "check-add", field, text: more.join(" ") };
				break;
			case "toggle":
			case "remove":
				op = {
					op: verb === "toggle" ? "check-toggle" : "check-remove",
					field,
					selector: more.join(" "),
				};
				break;
			case "done":
			case "undone":
				op = {
					op: "check-set",
					field,
					selector: more.join(" "),
					done: verb === "done",
				};
				break;
			case "edit":
				if (more.length < 2) throw new UsageError();
				op = {
					op: "check-edit",
					field,
					selector: more[0] as string,
					text: more.slice(1).join(" "),
				};
				break;
			default:
				throw new UsageError();
		}
		await runFieldOp(ctx, args, t.type, t.id, op, verb === "add");
	},
};
