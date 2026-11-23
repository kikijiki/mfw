import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
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
import { SandboxedCriticInference } from "../src/critic-inference.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";
import { type CageConfig, cagedSteps } from "./support/caged-launch.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * Wave 2 exit review, B2: the critic's CLI ran on the host, with the daemon's
 * environment, on agent-written diffs. A stub CLI under real bwrap reports what
 * it can actually see. The systemd layer is the cage's stand-in.
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
const skip = liveGate("critic-sandbox-live", skipReason());

/** What a CLI legitimately shares with the host by name. */
const NEUTRAL = new Set([
	"PATH",
	"LANG",
	"LC_ALL",
	"TERM",
	"TZ",
	"PWD",
	"SHLVL",
	"_",
]);

describe.skipIf(skip !== null)("the critic under a real sandbox", () => {
	let base: string;
	let mfwHome: string;
	let project: string;
	let stateDir: string;
	let cage: CageConfig;
	let handle: ProjectDbHandle;

	beforeAll(async () => {
		mkdirSync(FIXTURES, { recursive: true });
		base = realpathSync(mkdtempSync(join(FIXTURES, "c-")));
		const home = join(base, "h");
		const bin = join(home, ".local/bin");
		mkdirSync(bin, { recursive: true });
		mfwHome = join(base, "m");
		for (const rel of TEMPORARY_FLEET_WRITABLE.claude) {
			mkdirSync(join(mfwHome, "agents/claude", rel), { recursive: true });
		}
		mkdirSync(join(mfwHome, "workspaces"), { recursive: true });
		project = join(base, "p");
		stateDir = join(project, ".mfw");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(project, "secret.txt"), "project file\n");
		handle = await openProjectDb(stateDir);
		configureRunWorkspace(project, {
			kind: "clone",
			clone: { workspaceRoot: join(mfwHome, "workspaces") },
		});
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh
echo "prompt=$(cat)"
echo "args=$*"
echo "entries=$(ls -A . | wc -l)"
if [ -e "${project}/secret.txt" ]; then echo project=visible; else echo project=hidden; fi
env | sed 's/^/env:/'
`,
		);
		chmodSync(join(bin, "claude"), 0o755);
		const shim = join(base, "shim");
		writeFileSync(
			shim,
			'#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
		);
		chmodSync(shim, 0o755);
		const tools = ["sh", "cat", "env", "ls", "wc", "sed"]
			.map((t) => Bun.which(t))
			.filter((p): p is string => !!p)
			.map((p) => dirname(realpathSync(p)));
		cage = {
			home,
			path: [
				bin,
				dirname(BUN),
				dirname(realpathSync(GIT as string)),
				...new Set(tools),
			].join(":"),
			shim,
		};
	});

	afterAll(() => {
		clearRunWorkspace(project);
		handle.close();
		rmSync(base, { recursive: true, force: true });
	});

	test("the child has no daemon env and no project root", async () => {
		const reply = await new SandboxedCriticInference({
			projectRoot: project,
			mfwHome,
			stateDir,
			steps: cagedSteps(cage),
		}).complete("DIFF-TEXT", { model: "m", timeoutMs: 30_000 });
		const text = typeof reply === "string" ? reply : reply.text;
		expect(text).toContain("prompt=DIFF-TEXT");
		expect(text).not.toContain(
			"args=-p --model m --output-format json --tools  DIFF",
		);
		expect(text).toMatch(/entries=\s*0/);
		expect(text).toContain("project=hidden");
		const child = new Map(
			text
				.split("\n")
				.filter((l) => l.startsWith("env:"))
				.map((l) => {
					const kv = l.slice(4);
					const at = kv.indexOf("=");
					return [kv.slice(0, at), kv.slice(at + 1)] as const;
				}),
		);
		expect(child.size).toBeGreaterThan(0);
		const inherited = Object.entries(process.env)
			.filter(([k, v]) => !NEUTRAL.has(k) && v && child.get(k) === v)
			.map(([k]) => k);
		expect(inherited).toEqual([]);
		// Nothing of the call is left behind.
		expect(readdirSync(join(mfwHome, "workspaces"))).toEqual([]);
	}, 60_000);
});
