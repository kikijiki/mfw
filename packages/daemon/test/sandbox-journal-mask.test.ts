import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BwrapIsolation,
	bwrapCore,
	JOURNAL_DIRS,
	pinnedTool,
} from "../src/sandbox.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "mfw-journal-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const isolation = { hidePaths: [] } as unknown as BwrapIsolation;
const core = (journalDirs?: readonly string[]) =>
	bwrapCore({
		bwrapPath: "/bin/bwrap",
		cwd: "/tmp",
		runDir: "/tmp",
		isolation,
		...(journalDirs ? { journalDirs } : {}),
	});
const masked = (tokens: string[], path: string) =>
	tokens.some((t, i) => t === "--tmpfs" && tokens[i + 1] === path);

describe("the sandbox hides the system journal (reviewer B3)", () => {
	test("both journal locations are on the list", () => {
		expect(JOURNAL_DIRS).toContain("/var/log/journal");
		expect(JOURNAL_DIRS).toContain("/run/log/journal");
	});

	test("an existing journal directory is masked", () => {
		const d = temp();
		expect(masked(core([d]), d)).toBe(true);
	});

	test("a missing one is skipped, since bwrap cannot mount on it", () => {
		const d = join(temp(), "absent");
		expect(masked(core([d]), d)).toBe(false);
	});

	test("under real bwrap a journal file is not readable", async () => {
		const bwrap = pinnedTool("bwrap");
		const sh = pinnedTool("sh");
		const home = homedir();
		if (!bwrap || !sh || !existsSync(home)) {
			console.log("skip: bwrap, sh or HOME unavailable");
			return;
		}
		const d = temp();
		// Inside the run dir, because bwrap replaces the rest of /tmp.
		const journal = join(d, "journal");
		mkdirSync(journal);
		writeFileSync(join(journal, "user-1000.journal"), "canary");
		const argv = (dirs: readonly string[], script: string) => [
			...bwrapCore({
				bwrapPath: bwrap,
				cwd: d,
				runDir: d,
				isolation,
				journalDirs: dirs,
			}),
			sh,
			"-c",
			script,
		];
		// The control: without the mask the file is visible, so the check means something.
		const control = Bun.spawnSync(
			argv([], `cat ${journal}/user-1000.journal`),
			{
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		if (control.exitCode !== 0) {
			console.log("skip: bwrap cannot run here");
			return;
		}
		expect(control.stdout.toString()).toBe("canary");
		const run = Bun.spawnSync(argv([journal], `ls -A ${journal}`), {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString().trim()).toBe("");
	});
});
