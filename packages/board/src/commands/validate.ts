import {
	type ValidationIssue,
	type ValidationIssueKind,
	validateOwnsPattern,
	workflowIssues,
} from "@mfw/board-core";
import { CliError, type Command } from "./types.ts";
import { loadExemptions, requireNoPositional } from "./workflow-shared.ts";

/** Exit code per failure class; with several classes present the lowest wins. */
export const VALIDATE_EXIT: Record<ValidationIssueKind, number> = {
	document: 10,
	id: 11,
	reference: 12,
	hierarchy: 13,
	cycle: 14,
};

export const validate: Command = {
	name: "validate",
	usage: [
		"validate [--json]   (exit 0 ok; 10 document, 11 id, 12 reference, 13 hierarchy, 14 cycle - lowest present)",
	],
	async run(ctx, args) {
		requireNoPositional(args.positional);
		const { store, config } = ctx.project;
		const issues: ValidationIssue[] = await store.validate();
		// workflowIssues wants ids unique across the documents it is given, so
		// only types that declare a workflow take part.
		const docs = [];
		for (const [name, t] of Object.entries(config.types)) {
			if (t.workflow) docs.push(...(await store.listDocuments(name)));
		}
		if (docs.length > 0) issues.push(...workflowIssues(config, docs));

		// File scopes: every glob must be usable, and the exemptions file valid.
		for (const [name, t] of Object.entries(config.types)) {
			if (!t.ownership) continue;
			const mine = await store.listDocuments(name);
			for (const d of mine) {
				const globs =
					(d.fields[t.ownership.field] as string[] | undefined) ?? [];
				for (const g of globs) {
					const bad = validateOwnsPattern(g);
					if (bad) {
						issues.push({
							kind: "document",
							type: name,
							id: d.id,
							path: d.path,
							message: `${t.ownership.field} '${g}': ${bad}`,
						});
					}
				}
			}
			try {
				await loadExemptions(ctx, name, mine);
			} catch (e) {
				issues.push({
					kind: "document",
					type: name,
					id: "",
					path: t.ownership.exemptions ?? "",
					message: e instanceof Error ? e.message : String(e),
				});
			}
		}

		if (ctx.json) {
			console.log(
				JSON.stringify({
					ok: issues.length === 0,
					issues: issues.map((i) => ({
						kind: i.kind,
						type: i.type,
						id: i.id,
						path: i.path,
						message: i.message,
					})),
				}),
			);
		} else {
			for (const i of issues) {
				console.log(
					`${i.type} ${i.id ?? "(unknown id)"} ${i.path}: ${i.message}`,
				);
			}
			if (issues.length === 0) console.log("ok");
		}
		if (issues.length > 0) {
			const code = Math.min(...issues.map((i) => VALIDATE_EXIT[i.kind]));
			throw new CliError("", code);
		}
	},
};
