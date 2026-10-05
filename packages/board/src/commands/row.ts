import type { FieldOp } from "@mfw/board-core";
import { parseJson, runFieldOp, target } from "./field-op-shared.ts";
import { CliError, type Command, UsageError } from "./types.ts";

export const row: Command = {
	name: "row",
	usage: [
		"row [--type <type>] <id> <field> add <json> | set <rowId> <json> | remove <rowId>",
		"      (type: json list field; rows are keyed by their 'id'; also --base-rev <n>, --json)",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		const [verb, a, b] = t.tail;
		const field = t.field;
		if (t.spec.kind !== "scalar" || t.spec.type !== "json" || !t.spec.list) {
			throw new CliError(`'${field}' is not a 'type: json' list field`);
		}
		let op: FieldOp;
		if (verb === "add" && a !== undefined && b === undefined) {
			op = { op: "append", field, values: [parseJson(a, "row")] };
		} else if (verb === "set" && a !== undefined && b !== undefined) {
			const patch = parseJson(b, "row patch");
			if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
				throw new CliError("row patch must be a JSON object");
			}
			op = {
				op: "set-row",
				field,
				id: a,
				patch: patch as Record<string, unknown>,
			};
		} else if (verb === "remove" && a !== undefined && b === undefined) {
			op = { op: "remove-row", field, id: a };
		} else throw new UsageError();
		await runFieldOp(ctx, args, t.type, t.id, op);
	},
};
