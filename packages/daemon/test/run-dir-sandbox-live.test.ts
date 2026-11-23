import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { bwrapCore, pinnedTool, safeHostPath } from "../src/sandbox.ts";
import { fakeHome, installCleanup, usable } from "./support/review-fixes.ts";

/**
 * The real mount table of a split run, with the project under a writable HOME
 * (the layout that exposes `.mfw` unless it is masked). Fixtures only: HOME
 * points into a temp dir before bwrapCore reads it.
 */

installCleanup();

async function fixture() {
	const { base, home } = await fakeHome();
	process.env.HOME = home;
	const project = join(home, "project");
	const state = join(project, ".mfw");
	const runDir = join(state, "runs", "r1");
	const sibling = ensureRunDirLayout(join(state, "runs", "r2"));
	const layout = ensureRunDirLayout(runDir);
	const cwd = join(project, "worktrees", "r1");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(state, "mfw.db"), "db-canary");
	writeFileSync(join(runDir, "meta.json"), "meta-canary");
	writeFileSync(join(layout.control, "exit"), "exit:3");
	writeFileSync(join(layout.control, "driver.json"), "{}");
	writeFileSync(join(sibling.control, "exit"), "exit:9");
	return { base, home, project, state, runDir, layout, sibling, cwd };
}

function inSandbox(
	f: Awaited<ReturnType<typeof fixture>>,
	script: string,
	cwd = f.cwd,
): { status: number | null; stdout: string; stderr: string } {
	const bwrap = pinnedTool("bwrap") as string;
	const bash = pinnedTool("bash") as string;
	const argv = [
		...bwrapCore({
			bwrapPath: bwrap,
			cwd,
			runDir: f.runDir,
			isolation: { mode: "bwrap", hidePaths: [] },
			splitRunDir: true,
		}),
		"--setenv",
		"PATH",
		safeHostPath(),
		"--",
		bash,
		"-c",
		script,
	];
	const r = spawnSync(argv[0] as string, argv.slice(1), {
		cwd,
		encoding: "utf8",
		timeout: 20_000,
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Exit 0 only when the write really failed and the marker is absent. */
const refused = (cmd: string) =>
	`if ${cmd} 2>/dev/null; then echo WROTE; exit 1; fi`;

describe("split run dir under a real sandbox", () => {
	test("the run can use its cwd and outbox and read control (positive control)", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const f = await fixture();
		const r = inSandbox(
			f,
			`set -e
echo event > ${f.layout.outbox}/events.jsonl
echo work > ${f.cwd}/file
cat ${f.layout.control}/exit`,
		);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("exit:3");
		expect(readFileSync(join(f.layout.outbox, "events.jsonl"), "utf8")).toBe(
			"event\n",
		);
		expect(existsSync(join(f.cwd, "file"))).toBe(true);
	});

	test("control is read-only and cannot be replaced", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const f = await fixture();
		const c = f.layout.control;
		const r = inSandbox(
			f,
			[
				refused(`echo exit:0 > ${c}/exit`),
				refused(`touch ${c}/planted`),
				refused(`rm ${c}/exit`),
				refused(`mv ${c} ${f.runDir}/moved`),
				refused(`mv ${f.layout.outbox} ${f.runDir}/moved`),
				refused(`ln -s /tmp ${f.runDir}/link`),
				refused(`touch ${f.runDir}/planted`),
			].join("\n"),
		);
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		expect(readFileSync(join(c, "exit"), "utf8")).toBe("exit:3");
		expect(existsSync(join(c, "planted"))).toBe(false);
		expect(existsSync(join(f.runDir, "planted"))).toBe(false);
	});

	test("the DB, the run root's host files and sibling runs are absent", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const f = await fixture();
		const r = inSandbox(
			f,
			`for p in ${f.state}/mfw.db ${f.runDir}/meta.json ${f.sibling.root} ${f.sibling.control}/exit; do
  if [ -e "$p" ]; then echo "VISIBLE $p"; exit 1; fi
done
${refused(`touch ${f.state}/mfw.db`)}
${refused(`mkdir -p ${f.sibling.control}`)}`,
		);
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		expect(readFileSync(join(f.state, "mfw.db"), "utf8")).toBe("db-canary");
		expect(readFileSync(join(f.sibling.control, "exit"), "utf8")).toBe(
			"exit:9",
		);
	});

	test("a cwd inside the hidden state dir stays usable", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const f = await fixture();
		const scratch = join(f.state, "brain", "s1");
		mkdirSync(scratch, { recursive: true });
		const r = inSandbox(
			f,
			`set -e
echo note > ${scratch}/note
[ ! -e ${f.state}/mfw.db ]
cat ${f.layout.control}/driver.json`,
			scratch,
		);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(existsSync(join(scratch, "note"))).toBe(true);
	});

	test("the cwd being the project root does not re-expose the state dir", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const f = await fixture();
		const r = inSandbox(
			f,
			`[ ! -e ${f.state}/mfw.db ] || { echo VISIBLE; exit 1; }
echo ok > ${f.project}/from-agent`,
			realpathSync(f.project),
		);
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		expect(readFileSync(join(f.state, "mfw.db"), "utf8")).toBe("db-canary");
	});
});
