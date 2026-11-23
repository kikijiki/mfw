import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMigrations,
	verifyBuiltMigrations,
} from "@mfw/db/migration-source";
import pino from "pino";
import { AuthService, authDbPath } from "../src/auth/service.ts";
import { loadConfig } from "../src/config.ts";
import { buildExecPin } from "../src/containment/exec-pin.ts";
import {
	runDoctorCommand,
	runInitCommand,
	sandboxMarker,
} from "../src/doctor/cli.ts";
import { fileList, liveDoctorProbes } from "../src/doctor/live-probes.ts";
import { withReadOnlyDb } from "../src/doctor/readonly-db.ts";
import { DoctorReportSchema } from "../src/doctor/report.ts";
import { runDoctor } from "../src/doctor/run.ts";
import { ArmingStore } from "../src/triggers/arming.ts";
import { loadTriggerDefs } from "../src/triggers/def.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-doctor-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every path with its type, mode, mtime and content hash. */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = lstatSync(p);
			const hash = st.isFile()
				? createHash("sha256").update(readFileSync(p)).digest("hex")
				: "";
			out[p] = `${st.mode}:${st.mtimeMs}:${st.size}:${hash}`;
			if (st.isDirectory()) walk(p);
		}
	};
	walk(root);
	return out;
}

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: cwd,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
		},
	});
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/** A real install: config, auth store, legacy db, a project with a public remote. */
async function install() {
	const base = tmp();
	const home = join(base, "home");
	const repo = join(base, "repo");
	const bin = join(base, "bin");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(repo);
	mkdirSync(bin);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, ".gitignore"), ".mfw/\n");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	git(repo, "remote", "add", "origin", "https://github.com/example/demo.git");
	writeFileSync(join(repo, "untracked.env"), "SECRET_VALUE=do-not-print\n");
	mkdirSync(join(repo, ".mfw"));
	writeFileSync(join(repo, ".mfw", "state.json"), "{}\n");
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			projects: [{ name: "demo", root: repo, runWorkspace: "clone" }],
		}),
	);
	const auth = await AuthService.open(authDbPath(home));
	await auth.issueSetupToken();
	auth.close();
	mkdirSync(join(home, "host"), { mode: 0o700 });
	const legacy = new Database(join(home, "host", "host.db"));
	legacy.exec(
		"CREATE TABLE leases (id TEXT); INSERT INTO leases VALUES ('x');",
	);
	legacy.close();
	// A fake CLI on a temp PATH: agent-writable, so it must never be executed.
	const marker = join(base, "claude-ran");
	writeFileSync(
		join(bin, "claude"),
		`#!/bin/sh\ntouch ${marker}\necho 9.9.9\n`,
	);
	chmodSync(join(bin, "claude"), 0o755);
	return { base, home, repo, bin, marker };
}

describe("the live doctor on a real install", () => {
	test("changes nothing, runs no agent CLI and prints no secret", async () => {
		const i = await install();
		const before = snapshot(i.base);
		const env = { PATH: i.bin, HOST: "127.0.0.1" };
		const report = await runDoctor(
			liveDoctorProbes({ env, home: i.home, installRoot: i.base }),
		);
		expect(snapshot(i.base)).toEqual(before);
		expect(existsSync(i.marker)).toBe(false);
		expect(existsSync(join(i.repo, ".mfw", "triggers"))).toBe(false);

		DoctorReportSchema.parse(report);
		const text = JSON.stringify(report);
		expect(text).not.toContain("do-not-print");
		expect(text).not.toContain(
			readFileSync(join(i.home, "setup-token"), "utf8").trim(),
		);

		const by = (id: string) => report.checks.find((c) => c.id === id);
		expect(by("harness.claude")?.detail).toContain("not run");
		expect(by("auth.state")?.detail).toContain("first-run setup");
		expect(by("install.legacy-host")?.severity).toBe("blocker");
		expect(by("project.untracked")?.detail).toContain("1 untracked");
		expect(by("project.untracked")?.detail).toContain("1 ignored");
		expect(by("project.push")?.status).toBe("problem");
	});

	test("a malformed config never echoes its content", async () => {
		const i = await install();
		writeFileSync(join(i.home, "config.json"), '{"token": hunter2-secret');
		const report = await runDoctor(
			liveDoctorProbes({
				env: { PATH: i.bin },
				home: i.home,
				installRoot: i.base,
			}),
		);
		const c = report.checks.find((x) => x.id === "install.config");
		expect(c?.severity).toBe("blocker");
		expect(JSON.stringify(report)).not.toContain("hunter2");
	});
});

describe("running a trusted CLI", () => {
	test("gets only its version flag, no home and no inherited secrets", async () => {
		const i = await install();
		const seen = join(i.base, "seen");
		writeFileSync(
			join(i.bin, "claude"),
			`#!/bin/sh\nprintf '%s|%s|%s' "$*" "$HOME" "$ANTHROPIC_API_KEY" > ${seen}\necho "claude 2.3.4 raw-output-not-for-the-report"\n`,
		);
		const probes = liveDoctorProbes({
			env: { PATH: i.bin, ANTHROPIC_API_KEY: "inherited-secret-value" },
			home: i.home,
			installRoot: i.base,
			writableRoots: [join(i.base, "nothing-is-writable-here")],
		});
		const found = await probes.tool("claude");
		expect(found.path).toBe(join(i.bin, "claude"));
		expect(await probes.toolVersion(found.path as string)).toBe("2.3.4");
		expect(readFileSync(seen, "utf8")).toBe("--version|/nonexistent|");
	});
});

describe("build and trigger state", () => {
	test("a build without manifests is a blocker", async () => {
		const i = await install();
		mkdirSync(join(i.base, "apps/start/.output/server"), { recursive: true });
		const report = await runDoctor(
			liveDoctorProbes({
				env: { PATH: i.bin },
				home: i.home,
				installRoot: i.base,
			}),
		);
		const c = report.checks.find((x) => x.id === "install.build");
		expect([c?.status, c?.severity]).toEqual(["problem", "blocker"]);
		expect(c?.detail).toContain("host script manifest");
		expect(c?.detail).toContain("migration manifest");
	});

	test("built migrations verify, and a changed one is refused", () => {
		const output = join(tmp(), "apps/start/.output");
		mkdirSync(output, { recursive: true });
		const source = join(import.meta.dir, "../../db/migrations");
		const manifest = buildMigrations(source, output);
		expect(() => verifyBuiltMigrations(output)).not.toThrow();
		const name = Object.keys(manifest.files).find((f) => f.endsWith(".sql"));
		const file = join(output, "server/migrations", name as string);
		chmodSync(file, 0o644);
		writeFileSync(file, "DROP TABLE tasks;");
		expect(() => verifyBuiltMigrations(output)).toThrow("manifest hash");
	});

	test("an armed script is current until its pinned file changes", async () => {
		const i = await install();
		const script = join(i.repo, "deploy.sh");
		writeFileSync(script, "#!/bin/sh\necho deployed\n");
		chmodSync(script, 0o755);
		git(i.repo, "add", "deploy.sh");
		git(i.repo, "commit", "-q", "-m", "deploy");
		const dir = join(i.repo, ".mfw", "triggers");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "deploy.md"),
			"---\nid: deploy\non: merge.completed\naction: script\nrun: ./deploy.sh\n---\n",
		);
		const { defs } = await loadTriggerDefs(dir, pino({ level: "silent" }));
		const def = defs[0];
		if (!def) throw new Error("the trigger did not load");
		const built = await buildExecPin({ root: i.repo, run: "./deploy.sh" });
		if (!built.ok) throw new Error(built.reason);
		await ArmingStore.at(i.home, "demo").arm(def.id, def.hash, {
			execPin: built.pin,
		});
		const probes = () =>
			liveDoctorProbes({
				env: { PATH: i.bin },
				home: i.home,
				installRoot: i.base,
			});
		const triggers = async () =>
			(await runDoctor(probes())).checks.find(
				(c) => c.id === "project.triggers",
			);

		const before = snapshot(i.base);
		expect((await triggers())?.detail).toContain("1 armed and current");
		expect(snapshot(i.base)).toEqual(before);

		writeFileSync(script, "#!/bin/sh\necho tampered\n");
		const drifted = await triggers();
		expect(drifted?.status).toBe("problem");
		expect(drifted?.detail).toContain("deploy");
	});
});

describe("read-only database access", () => {
	test("reads rows still in a live WAL and cannot write", () => {
		const d = tmp();
		const path = join(d, "x.db");
		const writer = new Database(path);
		writer.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);",
		);
		const n = withReadOnlyDb(
			path,
			(db) =>
				(db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n,
		);
		expect(n).toBe(1);
		expect(() =>
			withReadOnlyDb(path, (db) => db.exec("INSERT INTO t VALUES (2)")),
		).toThrow();
		writer.close();
	});

	test("a closed database gains no sidecar files", () => {
		const d = tmp();
		const path = join(d, "x.db");
		const writer = new Database(path);
		writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x);");
		writer.close();
		withReadOnlyDb(path, (db) => db.query("SELECT * FROM t").all());
		expect(readdirSync(d)).toEqual(["x.db"]);
	});

	test("a live WAL database is left byte-identical, -shm included", () => {
		const d = tmp();
		const path = join(d, "x.db");
		const writer = new Database(path);
		writer.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);",
		);
		const before = snapshot(d);
		const n = withReadOnlyDb(
			path,
			(db) =>
				(db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n,
		);
		expect(n).toBe(2);
		expect(snapshot(d)).toEqual(before);
		writer.close();
	});

	test("an uncommitted or torn WAL tail is ignored", () => {
		const d = tmp();
		const path = join(d, "x.db");
		const writer = new Database(path);
		writer.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (x); INSERT INTO t VALUES (1);",
		);
		const wal = readFileSync(`${path}-wal`);
		const copy = join(d, "copy.db");
		writeFileSync(copy, readFileSync(path));
		// A partial frame after the last commit, as a crash would leave.
		writeFileSync(`${copy}-wal`, Buffer.concat([wal, Buffer.alloc(100, 7)]));
		const n = withReadOnlyDb(
			copy,
			(db) =>
				(db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n,
		);
		expect(n).toBe(1);
		writer.close();
	});

	test("a corrupt WAL is refused, not read as if empty", () => {
		const d = tmp();
		const path = join(d, "x.db");
		const writer = new Database(path);
		writer.exec("CREATE TABLE t (x);");
		writer.close();
		writeFileSync(`${path}-wal`, "not a wal file, but not empty either....");
		expect(() => withReadOnlyDb(path, () => 1)).toThrow("write-ahead log");
		expect(readFileSync(`${path}-wal`, "utf8")).toContain("not a wal");
	});
});

test("fileList drops a name cut off by the output limit", () => {
	expect(fileList("a\0b\0", false).count).toBe(2);
	expect(fileList("a\0b\0par", true)).toEqual({
		count: 2,
		sample: ["a", "b"],
		truncated: true,
	});
});

function cli(home: string, env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		deps: {
			env: { PATH: "", HOST: "127.0.0.1", ...env },
			home,
			out: (l: string) => out.push(l),
			err: (l: string) => err.push(l),
		},
	};
}

describe("mfw doctor", () => {
	test("--json parses against the schema; a blocker exits 1", async () => {
		const i = await install();
		const c = cli(i.home, { PATH: i.bin });
		expect(await runDoctorCommand(["--json"], c.deps)).toBe(1);
		const parsed = DoctorReportSchema.parse(JSON.parse(c.out.join("\n")));
		expect(parsed.ok).toBe(false);
	});

	test("an unknown option is a usage error", async () => {
		const c = cli(tmp());
		expect(await runDoctorCommand(["--fix"], c.deps)).toBe(2);
	});

	for (const marker of [
		"MFW_RUN_ID",
		"MFW_TASK_ID",
		"MFW_RUN_KIND",
		"MFW_AGENT_BRIDGED",
	]) {
		test(`refuses inside an agent run (${marker})`, async () => {
			const c = cli(tmp(), { [marker]: "1" });
			expect(await runDoctorCommand([], c.deps)).toBe(3);
			expect(c.out).toEqual([]);
			expect(c.err.join("")).toContain("outside any agent sandbox");
			expect(await runInitCommand([], c.deps)).toBe(3);
		});
	}

	test("an empty marker from a host-run trigger is not a sandbox", () => {
		expect(sandboxMarker({ MFW_RUN_ID: "" })).toBeNull();
	});
});

describe("mfw init", () => {
	test("prints the token path, never the token, and writes nothing", async () => {
		const i = await install();
		const token = readFileSync(join(i.home, "setup-token"), "utf8").trim();
		const before = snapshot(i.base);
		const c = cli(i.home, { PATH: i.bin });
		await runInitCommand(["--project", i.repo, "--name", "other"], c.deps);
		const text = c.out.join("\n");
		expect(text).toContain(join(i.home, "setup-token"));
		expect(text).not.toContain(token);
		expect(text).toContain('"runWorkspace": "clone"');
		expect(text).toContain("not written");
		expect(snapshot(i.base)).toEqual(before);
	});

	test("--first-run on the doctor is the same flow", async () => {
		const i = await install();
		const c = cli(i.home, { PATH: i.bin });
		await runDoctorCommand(["--first-run"], c.deps);
		expect(c.out.join("\n")).toContain("Next steps:");
	});

	test("--write adds the entry and refuses a duplicate", async () => {
		const i = await install();
		const second = join(i.base, "second");
		mkdirSync(second);
		git(second, "init", "-q", "-b", "trunk");
		const c = cli(i.home, { PATH: i.bin });
		await runInitCommand(["--project", second, "--write"], c.deps);
		const cfg = await loadConfig(i.home);
		const added = cfg.projects.find((p) => p.root === second);
		expect(added?.integrationBranch).toBe("trunk");
		expect(added?.runWorkspace).toBe("clone");

		const again = cli(i.home, { PATH: i.bin });
		expect(
			await runInitCommand(["--project", second, "--write"], again.deps),
		).toBe(1);
		expect(again.err.join("")).toContain("already uses");
		expect((await loadConfig(i.home)).projects).toHaveLength(2);
	});

	test("--write needs --project", async () => {
		const c = cli(tmp());
		expect(await runInitCommand(["--write"], c.deps)).toBe(2);
	});
});
