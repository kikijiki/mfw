import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** Each is either the runner itself or never touches a repository an agent wrote. */
const ALLOWED = new Map([
	["git.ts", "the hardened runner"],
	["host-git/landing.ts", "the host-owned repository, with an empty config"],
	["host-git/push.ts", "pushes from the landing repository"],
	["host-git/repo-config.ts", "reads config files with --file only"],
	["host-git/runner.ts", "HostGit, with its own empty config"],
	["run-workspace/seed.ts", "uses HostGit's configArgs"],
	["run-workspace/rebase-clone.ts", "uses HostGit's environment"],
	["run-workspace/wip-helper.ts", "runs inside the agent's sandbox"],
	["host-git/fetch.ts", "argv for the in-sandbox bundle helper"],
	["deployment-smoke.ts", "a disposable project it creates itself"],
	["deploy-mfw.ts", "its default runner routes git through hostGitCommand"],
]);

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return sources(path);
		return e.name.endsWith(".ts") ? [path] : [];
	});
}

const DIRECT =
	/(?:runProc|runProcRecords|Bun\.spawn|Bun\.spawnSync|spawn|spawnSync|execFile)\(\s*\[\s*(?:"git"|requireHostTool\("git"\))/;

describe("every host git call goes through the hardened runner", () => {
	test("no source file spawns git directly", () => {
		const offenders = sources(SRC)
			.filter((path) => !ALLOWED.has(relative(SRC, path)))
			.filter((path) => DIRECT.test(readFileSync(path, "utf8")))
			.map((path) => relative(SRC, path));
		expect(offenders).toEqual([]);
	});
});
