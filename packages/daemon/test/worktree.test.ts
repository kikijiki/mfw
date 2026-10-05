import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { MFW_EXCLUDE } from "./fixtures/board.ts";

/**
 * Run worktrees do not contain the board. Sparse checkout leaves nothing for
 * agents to damage (the merge-path firewall only cleans up); assertions here
 * are measured git behaviour.
 */

const roots: string[] = [];

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-wt-"));
	roots.push(root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);

	await mkdir(join(root, ".mfw/tasks/ready"), { recursive: true });
	await mkdir(join(root, ".mfw/adrs"), { recursive: true });
	await mkdir(join(root, ".mfw/lifetime"), { recursive: true });
	await mkdir(join(root, ".mfw/triggers"), { recursive: true });
	await mkdir(join(root, ".mfw/state"), { recursive: true });
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(
		join(root, ".mfw/tasks/ready/MFW-1-alpha.md"),
		"---\nid: MFW-1\nrev: 1\ntitle: alpha\n---\n\nthe real body\n",
	);
	await writeFile(join(root, ".mfw/adrs/0001-s.md"), "adr body\n");
	await writeFile(join(root, ".mfw/config.yaml"), "name: demo\n");
	await writeFile(join(root, ".mfw/AGENTS.md"), "the rules\n");
	await writeFile(join(root, ".mfw/lifetime/daily.md"), "daily\n");
	await writeFile(join(root, ".mfw/triggers/deploy.md"), "deploy v1\n");
	await writeFile(join(root, ".mfw/triggers/obsolete.md"), "obsolete\n");
	await writeFile(join(root, ".mfw/state/tracked"), "runtime\n");
	await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
	await git(["add", "-A"], root);
	await git(["add", "-f", "--", ".mfw/state/tracked"], root);
	await git(["commit", "-q", "-m", "init with a board"], root);
	return root;
}

afterEach(async () => {
	for (const r of roots.splice(0)) {
		await rm(r, { recursive: true, force: true });
	}
});

describe("a run worktree cannot see the board", () => {
	test("the managed exclude permits human-authored templates", async () => {
		const root = await repo();
		await Bun.write(
			join(root, ".mfw/templates/task.md"),
			"## Goal\nDescribe it.\n",
		);
		expect(
			(await git(["check-ignore", ".mfw/templates/task.md"], root)).exitCode,
		).toBe(1);
		expect((await git(["add", ".mfw/templates/task.md"], root)).exitCode).toBe(
			0,
		);
		expect((await git(["diff", "--cached", "--name-only"], root)).stdout).toBe(
			".mfw/templates/task.md",
		);
	});

	test("a git inspection error is never treated as a clean worktree", async () => {
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const wt = await mgr.create("broken-status");
		await rename(join(root, ".git"), join(root, ".git-disabled"));
		await expect(mgr.isDirty(wt)).rejects.toThrow(/prove worktree clean/);
	});

	test("only trigger definitions and a delivered AGENTS.md are present under .mfw", async () => {
		const root = await repo();
		const wt = await new WorktreeManager(root).create("run1");

		expect(existsSync(join(wt.path, ".mfw/tasks"))).toBe(false);
		expect(existsSync(join(wt.path, ".mfw/adrs"))).toBe(false);
		// Definitions are code the daemon runs on a schedule, and config.yaml is where an
		// executable string would land if `worktreeSetup` existed, so none may be reachable.
		expect(existsSync(join(wt.path, ".mfw/config.yaml"))).toBe(false);
		expect(existsSync(join(wt.path, ".mfw/lifetime"))).toBe(false);
		expect(existsSync(join(wt.path, ".mfw/state"))).toBe(false);
		expect(
			await readFile(join(wt.path, ".mfw/triggers/deploy.md"), "utf8"),
		).toBe("deploy v1\n");
		expect(existsSync(join(wt.path, "src/a.ts"))).toBe(true);

		// AGENTS.md stays readable, as a copy over a sparse-excluded path, so it cannot be committed back.
		expect(await readFile(join(wt.path, ".mfw/AGENTS.md"), "utf8")).toBe(
			"the rules\n",
		);

		// A skip-worktree entry is not reported as deleted (keeps `git status` honest and `commit -a` harmless); the copy is byte-identical to HEAD's.
		expect((await git(["status", "--porcelain"], wt.path)).stdout).toBe("");
		const marks = (await git(["ls-files", "-t", "--", ".mfw"], wt.path)).stdout;
		expect(marks).toContain("S .mfw/tasks/ready/MFW-1-alpha.md");
		expect(marks).toContain("S .mfw/adrs/0001-s.md");
		expect(marks).toContain("S .mfw/lifetime/daily.md");
		expect(marks).toContain("S .mfw/config.yaml");
		expect(marks).toContain("H .mfw/triggers/deploy.md");
	});

	test("trigger definitions can be added, edited and deleted with ordinary git add", async () => {
		const root = await repo();
		const wt = await new WorktreeManager(root).create("trigger-author");
		await writeFile(join(wt.path, ".mfw/triggers/deploy.md"), "deploy v2\n");
		await rm(join(wt.path, ".mfw/triggers/obsolete.md"));
		await writeFile(join(wt.path, ".mfw/triggers/new.md"), "new trigger\n");

		const added = await git(["add", "-A", "--", ".mfw/triggers"], wt.path);
		expect(added.exitCode).toBe(0);
		expect(
			(await git(["diff", "--cached", "--name-status"], wt.path)).stdout,
		).toBe(
			[
				"M\t.mfw/triggers/deploy.md",
				"A\t.mfw/triggers/new.md",
				"D\t.mfw/triggers/obsolete.md",
			].join("\n"),
		);
	});

	test("an agent that rewrites the delivered AGENTS.md cannot commit it", async () => {
		// Writing to a sparse-excluded path clears its skip-worktree bit on the next index
		// refresh (`S` to `H`), so `git status` shows it modified. `add -A`, `add -f` and
		// `commit -a` still refuse to stage it; only `add --sparse` does, and the merge firewall reverts that.
		const root = await repo();
		const wt = await new WorktreeManager(root).create("run1");
		await writeFile(join(wt.path, ".mfw/AGENTS.md"), "no rules\n");
		await writeFile(join(wt.path, "src/b.ts"), "export const b = 2;\n");

		const addAll = await git(["add", "-A"], wt.path);
		expect(addAll.exitCode).toBe(0);
		expect(
			(await git(["diff", "--cached", "--name-only"], wt.path)).stdout,
		).toBe("src/b.ts");
		const forced = await git(["add", "-f", "--", ".mfw/AGENTS.md"], wt.path);
		expect(forced.exitCode).not.toBe(0);
		expect(forced.stderr + forced.stdout).toContain("sparse-checkout");

		await git(
			["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qam", "agent"],
			wt.path,
		);
		const touched = (
			await git(["show", "--name-only", "--format=", "HEAD"], wt.path)
		).stdout;
		expect(touched).toContain("src/b.ts");
		expect(touched).not.toContain(".mfw/");
		expect(
			(await git(["show", `${wt.branch}:.mfw/AGENTS.md`], root)).stdout,
		).toBe("the rules");
	});

	test("a repo with no AGENTS.md still gets a worktree", async () => {
		const root = await repo();
		await rm(join(root, ".mfw/AGENTS.md"));
		await git(["commit", "-qam", "drop the rules"], root);
		const wt = await new WorktreeManager(root).create("run1");
		expect(existsSync(join(wt.path, ".mfw/AGENTS.md"))).toBe(false);
		expect((await git(["status", "--porcelain"], wt.path)).stdout).toBe("");
	});

	test("the PRIMARY checkout keeps its board and its config", async () => {
		// `core.sparseCheckout` must be per-worktree; in the shared config it would hide the human's board.
		const root = await repo();
		await new WorktreeManager(root).create("run1");

		expect(existsSync(join(root, ".mfw/tasks/ready/MFW-1-alpha.md"))).toBe(
			true,
		);
		expect(
			(await git(["status", "--porcelain", "--", ".mfw"], root)).stdout,
		).toBe("");
		const shared = await readFile(join(root, ".git/config"), "utf8");
		expect(shared).not.toContain("sparseCheckout");
	});

	test("an agent that recreates a task file cannot stage or commit it", async () => {
		const root = await repo();
		const wt = await new WorktreeManager(root).create("run1");
		const before = (
			await git(["show", "main:.mfw/tasks/ready/MFW-1-alpha.md"], root)
		).stdout;

		// The full hostile repertoire, in one worktree.
		await mkdir(join(wt.path, ".mfw/tasks/ready"), { recursive: true });
		await writeFile(
			join(wt.path, ".mfw/tasks/ready/MFW-1-alpha.md"),
			"---\nid: MFW-1\nrev: 99\ntitle: HIJACKED\n---\n",
		);
		await writeFile(
			join(wt.path, ".mfw/tasks/ready/MFW-777-invented.md"),
			"---\nid: MFW-777\nrev: 1\ntitle: invented\n---\n",
		);
		await writeFile(join(wt.path, "src/b.ts"), "export const b = 2;\n");

		// `git add -A` refuses the board paths loudly; real work is still staged.
		const addAll = await git(["add", "-A"], wt.path);
		expect(addAll.exitCode).not.toBe(0);
		expect(addAll.stderr + addAll.stdout).toContain("sparse-checkout");
		expect(
			(await git(["diff", "--cached", "--name-only"], wt.path)).stdout,
		).toBe("src/b.ts");
		const forced = await git(
			["add", "-f", "--", ".mfw/tasks/ready/MFW-1-alpha.md"],
			wt.path,
		);
		expect(forced.exitCode).not.toBe(0);
		expect(forced.stderr + forced.stdout).toContain("sparse-checkout");

		const commit = await git(
			["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qam", "agent"],
			wt.path,
		);
		expect(commit.exitCode).toBe(0);

		// The commit carries the real work and nothing of the board.
		const touched = (
			await git(["show", "--name-only", "--format=", "HEAD"], wt.path)
		).stdout;
		expect(touched).toContain("src/b.ts");
		expect(touched).not.toContain(".mfw/");
		expect(
			(
				await git(
					["show", `${wt.branch}:.mfw/tasks/ready/MFW-1-alpha.md`],
					root,
				)
			).stdout,
		).toBe(before);
		expect(
			(
				await git(
					["show", `${wt.branch}:.mfw/tasks/ready/MFW-777-invented.md`],
					root,
				)
			).exitCode,
		).not.toBe(0);
	});

	test("a stray board file makes the worktree dirty, so it is preserved not reaped", async () => {
		// Cannot be staged, but signals an odd run, so keeping the worktree for review is right.
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const wt = await mgr.create("run1");
		expect(await mgr.isDirty(wt)).toBe(false);

		await mkdir(join(wt.path, ".mfw/tasks/ready"), { recursive: true });
		await writeFile(
			join(wt.path, ".mfw/tasks/ready/MFW-1-alpha.md"),
			"tampered\n",
		);
		expect(await mgr.isDirty(wt)).toBe(true);
		expect(await mgr.finalize(wt)).toEqual({ removed: false });
	});

	test("ignored files are dirty because ignored does not mean disposable", async () => {
		const root = await repo();
		await writeFile(join(root, ".gitignore"), "*.secret\n");
		await git(["add", ".gitignore"], root);
		await git(["commit", "-qm", "ignore secrets"], root);
		const mgr = new WorktreeManager(root);
		const wt = await mgr.create("ignored-data");
		await writeFile(join(wt.path, "credential.secret"), "must survive\n");

		expect(await mgr.isDirty(wt)).toBe(true);
		expect(await mgr.finalize(wt)).toEqual({ removed: false });
		expect(await readFile(join(wt.path, "credential.secret"), "utf8")).toBe(
			"must survive\n",
		);
	});

	test("MFW's report is disposable only with durable ingestion proof", async () => {
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const wt = await mgr.create("reported-run");
		const report = '{"status":"done","summary":"complete"}\n';
		await writeFile(join(wt.path, "MFW_REPORT.json"), report);
		const reportIdentity = {
			state: "present" as const,
			sha256: createHash("sha256").update(report).digest("hex"),
		};

		// Generic cleanup/maintenance has no finalize-journal proof, so the report is kept as local data.
		expect(await mgr.isDirty(wt)).toBe(true);
		expect(await mgr.finalize(wt)).toEqual({ removed: false });
		expect(existsSync(wt.path)).toBe(true);

		// The finalizer may supply this identity only after finishStep(ingest_report).
		expect(await mgr.isDirty(wt, { reportIdentity })).toBe(false);
		expect(await mgr.finalize(wt, { reportIdentity })).toEqual({
			removed: true,
		});
		expect(existsSync(wt.path)).toBe(false);
	});

	test("report identity preserves rewrites, appearances, and unreadable paths", async () => {
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const changed = await mgr.create("report-changed");
		const original = '{"summary":"ingested"}\n';
		await writeFile(join(changed.path, "MFW_REPORT.json"), original);
		const reportIdentity = {
			state: "present" as const,
			sha256: createHash("sha256").update(original).digest("hex"),
		};
		await writeFile(
			join(changed.path, "MFW_REPORT.json"),
			'{"summary":"rewritten after ingest"}\n',
		);
		expect(await mgr.hasLocalChanges(changed, { reportIdentity })).toBe(true);

		const appeared = await mgr.create("report-appeared");
		await writeFile(join(appeared.path, "MFW_REPORT.json"), "{}\n");
		expect(
			await mgr.hasLocalChanges(appeared, {
				reportIdentity: { state: "absent" },
			}),
		).toBe(true);

		const unreadable = await mgr.create("report-unreadable");
		await mkdir(join(unreadable.path, "MFW_REPORT.json"));
		expect(
			await mgr.hasLocalChanges(unreadable, {
				reportIdentity: { state: "absent" },
			}),
		).toBe(true);
	});

	test("a report rewrite after quarantine restores and preserves the worktree", async () => {
		const root = await repo();
		const original = '{"summary":"ingested"}\n';
		const reportIdentity = {
			state: "present" as const,
			sha256: createHash("sha256").update(original).digest("hex"),
		};
		class QuarantineRaceManager extends WorktreeManager {
			checks = 0;
			override async hasLocalChanges(
				wt: Parameters<WorktreeManager["hasLocalChanges"]>[0],
				opts: Parameters<WorktreeManager["hasLocalChanges"]>[1],
			): Promise<boolean> {
				this.checks++;
				if (this.checks === 2) {
					await writeFile(
						join(wt.path, "MFW_REPORT.json"),
						'{"summary":"changed in quarantine"}\n',
					);
				}
				return super.hasLocalChanges(wt, opts);
			}
		}
		const mgr = new QuarantineRaceManager(root);
		const wt = await mgr.create("report-quarantine-race");
		await writeFile(join(wt.path, "MFW_REPORT.json"), original);

		await expect(
			mgr.remove(wt, { force: false, reportIdentity }),
		).rejects.toThrow(/changed while quarantining/);
		expect(existsSync(wt.path)).toBe(true);
		expect(await readFile(join(wt.path, "MFW_REPORT.json"), "utf8")).toContain(
			"changed in quarantine",
		);
	});

	test("a stale path and branch cannot authorize deleting a replacement worktree", async () => {
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const stale = await mgr.create("stale-owner");
		await git(["worktree", "remove", "--force", stale.path], root);
		await git(["worktree", "add", "-q", stale.path, stale.branch], root);
		await writeFile(join(stale.path, "manual.txt"), "foreign work\n");

		expect(await mgr.ownership(stale.path)).toBeNull();
		await expect(mgr.remove(stale)).rejects.toThrow(/unproven worktree/);
		expect(await readFile(join(stale.path, "manual.txt"), "utf8")).toBe(
			"foreign work\n",
		);
	});

	test("owned removal quarantines first and compare-deletes its exact branch", async () => {
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const wt = await mgr.create("owned-remove");
		expect(await mgr.ownership(wt.path)).toMatchObject({
			runId: "owned-remove",
			branch: wt.branch,
			baseSha: wt.baseSha,
		});

		await mgr.remove(wt);

		expect(existsSync(wt.path)).toBe(false);
		expect((await git(["rev-parse", wt.branch], root)).exitCode).not.toBe(0);
	});

	test("worktrees stay independent of each other", async () => {
		const root = await repo();
		const mgr = new WorktreeManager(root);
		const a = await mgr.create("runA");
		const b = await mgr.create("runB");
		for (const wt of [a, b]) {
			expect(existsSync(join(wt.path, ".mfw/tasks"))).toBe(false);
			expect((await git(["status", "--porcelain"], wt.path)).stdout).toBe("");
		}
		await writeFile(join(a.path, "src/a.ts"), "changed by A\n");
		expect(await readFile(join(b.path, "src/a.ts"), "utf8")).toBe(
			"export const a = 1;\n",
		);
		expect(await mgr.isDirty(b)).toBe(false);
	});

	test("a repo with no board at all still gets a worktree", async () => {
		// The sparse patterns name paths that need not exist.
		const root = await mkdtemp(join(tmpdir(), "mfw-wt-bare-"));
		roots.push(root);
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await writeFile(join(root, "only.txt"), "code\n");
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "init"], root);

		const wt = await new WorktreeManager(root).create("run1");
		expect(existsSync(join(wt.path, "only.txt"))).toBe(true);
		expect((await git(["status", "--porcelain"], wt.path)).stdout).toBe("");
	});
});
