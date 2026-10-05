import { runFieldOp, target } from "./field-op-shared.ts";
import { CliError, type Command, UsageError } from "./types.ts";

const step = (name: "inc" | "dec"): Command => ({
	name,
	usage: [
		`${name} [--type <type>] <id> <field> [n] [--base-rev <n>] [--json]   (number field, default 1)`,
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		if (t.tail.length > 1) throw new UsageError();
		let by: number | undefined;
		if (t.tail[0] !== undefined) {
			by = Number(t.tail[0]);
			if (!Number.isFinite(by)) throw new CliError("n must be a number");
		}
		await runFieldOp(ctx, args, t.type, t.id, { op: name, field: t.field, by });
	},
});

export const inc = step("inc");
export const dec = step("dec");

export const toggle: Command = {
	name: "toggle",
	usage: [
		"toggle [--type <type>] <id> <field> [--base-rev <n>] [--json]   (boolean field)",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		if (t.tail.length > 0) throw new UsageError();
		await runFieldOp(ctx, args, t.type, t.id, { op: "toggle", field: t.field });
	},
};

export const unset: Command = {
	name: "unset",
	usage: [
		"unset [--type <type>] <id> <field> [--base-rev <n>] [--json]   (optional field; a list becomes empty)",
	],
	async run(ctx, args) {
		const t = await target(ctx, args);
		if (t.tail.length > 0) throw new UsageError();
		await runFieldOp(ctx, args, t.type, t.id, { op: "unset", field: t.field });
	},
};
