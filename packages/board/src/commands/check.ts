import {
	type CheckIssue,
	type CheckRuleInfo,
	type CheckStat,
	collectIssues,
	ruleCatalog,
} from "@mfw/board-core";
import { CliError, type Command, type CommandContext } from "./types.ts";
import { allDocuments, checkUnder, descendantsOf } from "./workflow-shared.ts";

/** Where an issue points: a document, or a line of an external file. */
function subjectOf(i: CheckIssue): string {
	if (i.file !== undefined) return i.line ? `${i.file}:${i.line}` : i.file;
	if (i.id) return `${i.type ?? ""} ${i.id}`.trim();
	return i.path ?? "(unknown)";
}

function ruleList(ctx: CommandContext, rules: readonly CheckRuleInfo[]): void {
	if (ctx.json) {
		console.log(JSON.stringify(rules));
		return;
	}
	for (const r of rules) {
		console.log(`${r.id}\t${r.severity}\t${r.reads}\t${r.description}`);
	}
}

export const check: Command = {
	name: "check",
	usage: [
		"check [<id>] [--rule a,b] [--under <id>] [--board-only] [--root name=path] [--strict] [--json]",
		"      (every rule: structure, references, hierarchy, cycles, readiness, file scopes, field rules, refs;",
		"       exit 1 on an error issue, 3 if a check cannot run; advisory issues print but pass unless --strict)",
		"check --list [--json]   (the rules, their severity and what they read)",
	],
	async run(ctx, args) {
		if (args.positional.length > 1)
			throw new CliError("check takes at most one id", 2);
		const [id] = args.positional;
		if (args.override) {
			throw new CliError(
				"--override applies to writes; check always reports every violation",
				2,
			);
		}
		if (args.list) {
			ruleList(ctx, ruleCatalog(ctx.project.config));
			return;
		}
		const known = new Set(ruleCatalog(ctx.project.config).map((r) => r.id));
		for (const r of args.rule ?? []) {
			if (!known.has(r)) {
				throw new CliError(
					`unknown rule '${r}' (rules: ${[...known].join(", ")})`,
					2,
				);
			}
		}
		const { config, store, root } = ctx.project;
		let issues: CheckIssue[];
		let within: Set<string> | undefined;
		const stats: CheckStat[] = [];
		try {
			issues = await collectIssues(store, config, root, {
				...(args.rule && args.rule.length > 0
					? { rules: new Set(args.rule) }
					: {}),
				boardOnly: args.boardOnly,
				stats,
				...(args.roots ? { rootOverrides: args.roots } : {}),
			});
			if (id !== undefined || args.under !== undefined) {
				const docs = await allDocuments(ctx);
				if (id !== undefined && !docs.some((d) => d.id === id)) {
					throw new CliError(`'${id}' not found`, 2);
				}
				checkUnder(config, docs, args.under);
				if (args.under !== undefined) {
					within = descendantsOf(config, docs, args.under);
					within.add(args.under);
				}
			}
		} catch (e) {
			if (e instanceof CliError) throw e;
			throw new CliError(e instanceof Error ? e.message : String(e), 3);
		}
		const only = args.rule && args.rule.length > 0 ? new Set(args.rule) : null;
		issues = issues.filter(
			(i) =>
				(only === null || only.has(i.rule)) &&
				(id === undefined || i.id === id || i.related?.includes(id)) &&
				(within === undefined || (i.id != null && within.has(i.id))),
		);
		const errors = issues.filter((i) => i.severity === "error").length;
		const advisory = issues.length - errors;
		const failed = errors > 0 || (args.strict && advisory > 0);
		if (ctx.json) {
			console.log(
				JSON.stringify({
					ok: !failed,
					issues,
					...(stats.length > 0 ? { scans: stats } : {}),
				}),
			);
		} else {
			for (const i of issues) {
				console.log(`${i.severity} ${i.rule} ${subjectOf(i)}: ${i.message}`);
			}
			for (const s of stats) {
				console.log(
					s.kind === "refs"
						? `scanned ${s.rule}: ${s.matches} ref(s) in ${s.files} file(s)${s.skipped > 0 ? `, ${s.skipped} skipped` : ""}`
						: `coverage ${s.rule}: ${s.open} open of ${s.rows} row(s), ${s.covered} covered, ${s.waived} waived`,
				);
			}
			if (issues.length === 0) console.log("ok");
			else if (!failed) console.log(`ok: ${advisory} advisory issue(s)`);
		}
		if (failed) throw new CliError("", 1);
	},
};
