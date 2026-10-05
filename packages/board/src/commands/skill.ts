import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ALL_TOOLS,
	detect,
	fileState,
	findProjectRoot,
	parseTargets,
	plan,
	type Scope,
	type ToolId,
} from "./skill-targets.ts";
import { CliError, type Command, UsageError } from "./types.ts";

/**
 * Copies the packaged SKILL.md (Agent Skills format) into each selected agent
 * tool's skills directory. A plain file copy, not a symlink: the installing
 * project may not be this checkout.
 */
export const skill: Command = {
	name: "skill",
	usage: [
		"skill install [--global] [--here] [--target <claude,codex,opencode,pi|all|detected>] [--dry-run]",
		"skill status [--global] [--target <list>]",
	],
	needsBoard: false,
	async run(ctx, args) {
		const verb = args.positional[0];
		if (verb !== "install" && verb !== "status") throw new UsageError();
		const env = process.env;
		const scope: Scope = args.global ? "global" : "project";
		// Project scope installs at the repo root (nearest .git), not a subdirectory.
		const cwd = args.here ? process.cwd() : findProjectRoot(process.cwd());
		// The packaged text says `<mfw-checkout>`; installed copies name the real one.
		const packaged = readFileSync(
			join(import.meta.dir, "../../skill/SKILL.md"),
			"utf8",
		).replaceAll("<mfw-checkout>", resolve(import.meta.dir, "../../../.."));
		const targetArg = args.target ?? (verb === "install" ? "detected" : "all");
		const selected: ToolId[] | null = parseTargets(targetArg, env);
		if (!selected) throw new UsageError();

		if (verb === "status") {
			const rows = plan(selected, scope, cwd, env).map((e) => {
				const detected = detect(e.tool, env);
				const state = fileState(e.coveredBy ?? e.path, packaged);
				return {
					tool: e.tool,
					detected,
					scope,
					path: e.path,
					state,
					coveredBy: e.coveredBy ?? null,
				};
			});
			rows.sort(
				(a, b) => ALL_TOOLS.indexOf(a.tool) - ALL_TOOLS.indexOf(b.tool),
			);
			if (ctx.json) console.log(JSON.stringify(rows, null, 2));
			else {
				// stderr: keeps stdout one parseable row per tool.
				if (scope === "project") console.error(`project root: ${cwd}`);
				for (const r of rows)
					console.log(
						`${r.tool} ${r.detected ? "detected" : "not detected"} ${r.path} ${r.state}${r.coveredBy ? ` (covered by ${r.coveredBy})` : ""}`,
					);
			}
			return;
		}

		if (selected.length === 0)
			throw new CliError(
				"no supported agent tool detected (supported: claude, codex, opencode, pi); pass --target <claude,codex,opencode,pi|all>",
			);
		if (scope === "project") console.error(`project root: ${cwd}`);
		for (const e of plan(selected, scope, cwd, env)) {
			if (e.coveredBy) {
				console.log(`covered ${e.tool} by ${e.coveredBy}`);
				continue;
			}
			if (fileState(e.path, packaged) === "installed") {
				console.log(`up-to-date ${e.tool} -> ${e.path}`);
				continue;
			}
			if (!args.dryRun) {
				mkdirSync(dirname(e.path), { recursive: true });
				writeFileSync(e.path, packaged);
			}
			console.log(
				`${args.dryRun ? "would install" : "installed"} ${e.tool} -> ${e.path}`,
			);
		}
	},
};
