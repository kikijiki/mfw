import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runHeadSourceRef,
	sandboxBundleArgv,
	wipSourcePrefix,
} from "../src/host-git/fetch.ts";
import { wipControlLine } from "../src/run-workspace/wip-helper.ts";
import {
	helperBundleArgs,
	wipHelperScript,
} from "../src/run-workspace/wip-helper-install.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
	const root = mkdtempSync(join(tmpdir(), "mfw-wip-sup-"));
	dirs.push(root);
	const tree = join(root, "tree");
	const gitDir = join(root, "git");
	const outbox = join(root, "outbox");
	const control = join(root, "control.jsonl");
	for (const d of [tree, outbox]) mkdirSync(d);
	writeFileSync(control, "");
	const env = {
		...process.env,
		GIT_DIR: gitDir,
		GIT_WORK_TREE: tree,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const g = (...a: string[]) =>
		Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
			cwd: tree,
			env,
		});
	g("init", "-q", "-b", "mfw/r1");
	writeFileSync(join(tree, "a.txt"), "one\n");
	g("add", "-A");
	g("commit", "-q", "-m", "init");
	const script = join(root, "wip-helper.js");
	writeFileSync(script, wipHelperScript());
	return { root, tree, outbox, control, env, script };
}

const start = (r: ReturnType<typeof repo>, agent: string[]) =>
	Bun.spawn(
		[
			process.execPath,
			"--config=/dev/null",
			"--no-env-file",
			r.script,
			"exec",
			"--run",
			"r1",
			"--control",
			r.control,
			"--outbox",
			r.outbox,
			"--",
			...agent,
		],
		{
			cwd: r.tree,
			env: r.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);

describe("the installed helper", () => {
	test("is one file with node builtins only", () => {
		const imports = [
			...wipHelperScript().matchAll(/from\s*["']([^"']+)["']/g),
		].map((m) => m[1] as string);
		expect(imports.length).toBeGreaterThan(0);
		for (const i of imports) expect(i.startsWith("node:")).toBe(true);
	});

	test("names the same refs the host fetches", () => {
		expect(helperBundleArgs("r1", "/o")).toEqual(
			sandboxBundleArgv("r1", "/o").slice(1),
		);
		expect(helperBundleArgs("r1", "/o")).toContain(runHeadSourceRef("r1"));
		expect(helperBundleArgs("r1", "/o")).toContain(
			`--glob=${wipSourcePrefix("r1")}*`,
		);
	});

	test("runs the agent, keeps its stdio and exit code, and answers a snapshot while it runs", async () => {
		const r = repo();
		const p = start(r, [
			"sh",
			"-c",
			`echo out; echo edited > a.txt; while [ ! -e ${r.outbox}/wip-ack.json ]; do :; done; exit 7`,
		]);
		writeFileSync(r.control, wipControlLine("q1"));
		const out = await new Response(p.stdout).text();
		expect(await p.exited).toBe(7);
		expect(out).toBe("out\n");
		expect(
			JSON.parse(readFileSync(join(r.outbox, "wip-ack.json"), "utf8")),
		).toMatchObject({ id: "q1", ok: true, n: 1 });
		expect(existsSync(join(r.outbox, "result.bundle"))).toBe(true);
	});

	test("a planted ack path does not take the agent down", async () => {
		const r = repo();
		mkdirSync(join(r.outbox, "wip-ack.json"));
		mkdirSync(join(r.outbox, "wip-ack.json.tmp"));
		writeFileSync(r.control, wipControlLine("q1"));
		const p = start(r, [
			"sh",
			"-c",
			"i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done; exit 3",
		]);
		expect(await p.exited).toBe(3);
	});

	test("a hook and an fsmonitor planted in the clone never run during a snapshot", async () => {
		const r = repo();
		const canary = join(r.root, "canary");
		const hook = join(r.root, "git/hooks");
		mkdirSync(hook, { recursive: true });
		for (const name of ["pre-commit", "post-commit", "reference-transaction"]) {
			writeFileSync(join(hook, name), `#!/bin/sh\ntouch ${canary}\n`);
			chmodSync(join(hook, name), 0o755);
		}
		const mon = join(r.root, "mon.sh");
		writeFileSync(mon, `#!/bin/sh\ntouch ${canary}\n`);
		chmodSync(mon, 0o755);
		Bun.spawnSync(["git", "config", "core.fsmonitor", mon], {
			cwd: r.tree,
			env: r.env,
		});
		const p = start(r, [
			"sh",
			"-c",
			`echo x > b.txt; while [ ! -e ${r.outbox}/wip-ack.json ]; do :; done`,
		]);
		writeFileSync(r.control, wipControlLine("q1"));
		await p.exited;
		expect(
			JSON.parse(readFileSync(join(r.outbox, "wip-ack.json"), "utf8")).ok,
		).toBe(true);
		expect(existsSync(canary)).toBe(false);
	});
});
