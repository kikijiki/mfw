import { coerceListElement } from "@mfw/board-core";
import { parseIndex, runFieldOp, target } from "./field-op-shared.ts";
import { type Command, UsageError } from "./types.ts";

function values(
	t: Awaited<ReturnType<typeof target>>,
	raw: string[],
): unknown[] {
	if (raw.length === 0) throw new UsageError();
	return raw.map((v) => coerceListElement(t.spec, v));
}

const listCommand = (name: "append" | "prepend", blurb: string): Command => ({
	name,
	usage: [
		`${name} [--type <type>] <id> <field> <value...> [--base-rev <n>] [--json]   (${blurb})`,
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		await runFieldOp(ctx, args, t.type, t.id, {
			op: name,
			field: t.field,
			values: values(t, t.tail),
		});
	},
});

export const append = listCommand("append", "add to the end of a list field");
export const prepend = listCommand(
	"prepend",
	"add to the start of a list field",
);

export const insert: Command = {
	name: "insert",
	usage: [
		"insert [--type <type>] <id> <field> <index> <value...> [--base-rev <n>] [--json]   (0-based)",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		const index = parseIndex(t.tail[0], "index");
		await runFieldOp(ctx, args, t.type, t.id, {
			op: "insert",
			field: t.field,
			index,
			values: values(t, t.tail.slice(1)),
		});
	},
};

export const remove: Command = {
	name: "remove",
	usage: [
		"remove [--type <type>] <id> <field> <value> [--if-present] [--base-rev <n>] [--json]",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		if (t.tail.length !== 1) throw new UsageError();
		await runFieldOp(ctx, args, t.type, t.id, {
			op: "remove",
			field: t.field,
			value: coerceListElement(t.spec, t.tail[0] as string),
			ifPresent: args.ifPresent,
		});
	},
};

export const move: Command = {
	name: "move",
	usage: [
		"move [--type <type>] <id> <field> <from> <to> [--base-rev <n>] [--json]   (0-based indexes)",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		if (t.tail.length !== 2) throw new UsageError();
		await runFieldOp(ctx, args, t.type, t.id, {
			op: "move",
			field: t.field,
			from: parseIndex(t.tail[0], "from"),
			to: parseIndex(t.tail[1], "to"),
		});
	},
};
