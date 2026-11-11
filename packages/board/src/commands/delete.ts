import { idsIn } from "@mfw/board-core";
import { resolveDocumentType } from "./shared.ts";
import { CliError, type Command, UsageError } from "./types.ts";
import { allDocuments } from "./workflow-shared.ts";

/**
 * `delete`: remove a document and take it out of its parent's `children`.
 * Refused while it has children (the store) or while another document lists
 * it in its dependency field (here: that would leave a dangling dependency).
 */
export const del: Command = {
	name: "delete",
	usage: [
		"delete [--type <type>] <id>   (refused if it has children or another document depends on it)",
	],
	async run(ctx, args) {
		const id = args.positional[0];
		if (!id || args.positional.length > 1) throw new UsageError();
		const type = await resolveDocumentType(ctx, args, id);
		const { config, store } = ctx.project;
		if (!(await store.readDocument(type, id))) {
			throw new CliError(`${type} '${id}' not found`, 1);
		}
		const dependents: string[] = [];
		for (const d of await allDocuments(ctx)) {
			if (d.id === id) continue;
			const field =
				config.types[d.type]?.workflow?.ready.dependsOn ?? "depends_on";
			if (idsIn(d.fields[field]).includes(id)) dependents.push(d.id);
		}
		if (dependents.length > 0) {
			throw new CliError(
				`${type} '${id}' is a dependency of ${[...new Set(dependents)].sort().join(", ")}; remove it from their depends_on first`,
				1,
			);
		}
		try {
			await store.deleteDocument(type, id);
		} catch (e) {
			throw new CliError(e instanceof Error ? e.message : String(e), 1);
		}
		if (ctx.json) console.log(JSON.stringify({ deleted: { type, id } }));
		else console.log(`deleted ${type} ${id}`);
	},
};
