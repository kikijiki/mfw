import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { TEMPORARY_FLEET_WRITABLE } from "../src/containment/agent-profile.ts";
import { runOneShotAgent } from "../src/containment/oneshot-agent.ts";
import { socketRoot } from "../src/containment/socket-root.ts";
import { type CageConfig, cagedSteps } from "./support/caged-launch.ts";

/**
 * Security review P7, M3: the reviewer's proxy counters lived in a directory
 * deleted when the call ended, so what the role that reads candidate code sent
 * over the network left no record. A real proxy, under real bwrap.
 */

const FIXTURES = resolve(import.meta.dir, "../../../.work/live-sandbox");
const BWRAP = Bun.which("bwrap");
const BUN = realpathSync(Bun.which("bun") ?? process.execPath);
const GIT = Bun.which("git");

function skipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP || !GIT) return "no bwrap or git";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}
const skip = skipReason();
if (skip) console.log(`[oneshot-egress-ledger] skipped: ${skip}`);

const toolDirs = () =>
	["sh", "cat", "env", "sleep"]
		.map((t) => Bun.which(t))
		.filter((p): p is string => !!p)
		.map((p) => dirname(realpathSync(p)));

describe.skipIf(skip !== null)("the reviewer's egress", () => {
	let base: string;
	let mfwHome: string;
	let project: string;
	let stateDir: string;
	let tree: string;
	let cage: CageConfig;
	let handle: ProjectDbHandle;

	beforeAll(async () => {
		mkdirSync(FIXTURES, { recursive: true });
		// Short: the proxy's unix socket path lives under it.
		base = realpathSync(mkdtempSync(join(FIXTURES, "o-")));
		const home = join(base, "h");
		const bin = join(home, ".local/bin");
		mkdirSync(bin, { recursive: true });
		mfwHome = join(base, "m");
		for (const rel of TEMPORARY_FLEET_WRITABLE.claude) {
			mkdirSync(join(mfwHome, "agents/claude", rel), { recursive: true });
		}
		const clone = join(mfwHome, "workspaces/ro-fixture");
		tree = join(clone, "tree");
		mkdirSync(tree, { recursive: true });
		mkdirSync(join(clone, "git"));
		writeFileSync(join(clone, "mfw-workspace.json"), "{}");
		Bun.spawnSync([
			GIT as string,
			"--git-dir",
			join(clone, "git"),
			"init",
			"-q",
			"--template=",
		]);
		project = join(base, "p");
		stateDir = join(project, ".mfw");
		mkdirSync(stateDir, { recursive: true });
		handle = await openProjectDb(stateDir);
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh
[ "$HOME" = /sandbox/agent ] || exit 99
cat > /dev/null
bun --config=/dev/null --no-env-file -e 'await fetch("https://denied.invalid/").catch(() => {})'
echo reviewed
`,
		);
		chmodSync(join(bin, "claude"), 0o755);
		const shim = join(base, "shim");
		writeFileSync(
			shim,
			'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
		);
		chmodSync(shim, 0o755);
		cage = {
			home,
			path: [
				bin,
				dirname(BUN),
				dirname(realpathSync(GIT as string)),
				...new Set(toolDirs()),
			].join(":"),
			shim,
		};
	});

	afterAll(() => {
		handle.close();
		rmSync(base, { recursive: true, force: true });
	});

	test("what it tried to reach is in the host-observed ledger", async () => {
		const r = await runOneShotAgent({
			role: "reviewer",
			cli: "claude",
			tree,
			projectRoot: project,
			stateDir,
			mfwHome,
			argv: ["claude"],
			prompt: "review",
			timeoutMs: 30_000,
			maxOutputBytes: 1024 * 1024,
			steps: cagedSteps(cage),
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("reviewed");
		const rows = await handle.client.execute(
			"select run_id, destination, denied, provenance from run_egress",
		);
		const row = rows.rows.find((x) => x.destination === "denied.invalid:443");
		expect(row?.provenance).toBe("host-observed");
		expect(Number(row?.denied)).toBeGreaterThan(0);
		expect(String(row?.run_id)).toStartWith("review-");
		// Recorded first, then the call's directories go.
		expect(readdirSync(join(stateDir, "runs"))).toEqual([]);
		const sockets = join(socketRoot(mfwHome), "s");
		expect(existsSync(sockets)).toBe(true);
		expect(readdirSync(sockets)).toEqual([]);
	}, 45_000);
});
