import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildKind } from "../../../core/src/build-info.ts";
// Embedded, so a compiled mfw-board carries the skill it installs.
import packagedSkill from "../../skill/SKILL.md" with { type: "text" };
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
import {
	CliError,
	type Command,
	type CommandContext,
	UsageError,
} from "./types.ts";

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
		const env = ctx.env;
		const scope: Scope = args.global ? "global" : "project";
		// Project scope installs at the repo root (nearest .git), not a subdirectory.
		const cwd = args.here ? ctx.cwd : findProjectRoot(ctx.cwd);
		// The packaged text says `<mfw-checkout>`; installed copies name the real
		// one. A compiled mfw-board has no checkout, and keeps the placeholder.
		const packaged =
			buildKind() === "compiled"
				? packagedSkill
				: packagedSkill.replaceAll(
						"<mfw-checkout>",
						resolve(import.meta.dir, "../../../.."),
					);
		const targetArg = args.target ?? (verb === "install" ? "detected" : "all");
		const selected: ToolId[] | null = parseTargets(targetArg, env);
		if (!selected) throw new UsageError();

		if (verb === "status") {
			const entries = plan(selected, scope, cwd, env);
			const rows = entries.map((e) => {
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
			if (ctx.json) ctx.out(JSON.stringify(rows, null, 2));
			else {
				// stderr: keeps stdout one parseable row per tool.
				if (scope === "project") ctx.err(`project root: ${cwd}`);
				for (const r of rows)
					ctx.out(
						`${r.tool} ${r.detected ? "detected" : "not detected"} ${r.path} ${r.state}${r.coveredBy ? ` (covered by ${r.coveredBy})` : ""}`,
					);
			}
			return;
		}

		if (selected.length === 0)
			throw new CliError(
				"no supported agent tool detected (supported: claude, codex, opencode, pi); pass --target <claude,codex,opencode,pi|all>",
			);
		if (scope === "project") ctx.err(`project root: ${cwd}`);
		const entries = plan(selected, scope, cwd, env);
		for (const e of entries) {
			if (e.coveredBy) {
				ctx.out(`covered ${e.tool} by ${e.coveredBy}`);
				continue;
			}
			if (fileState(e.path, packaged) === "installed") {
				ctx.out(`up-to-date ${e.tool} -> ${e.path}`);
				continue;
			}
			if (!args.dryRun) {
				mkdirSync(dirname(e.path), { recursive: true });
				writeFileSync(e.path, packaged);
			}
			ctx.out(
				`${args.dryRun ? "would install" : "installed"} ${e.tool} -> ${e.path}`,
			);
		}
	},
};
