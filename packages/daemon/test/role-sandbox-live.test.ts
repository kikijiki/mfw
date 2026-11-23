import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	type AgentLaunchRequest,
	launchAgentSandbox,
} from "../src/containment/agent-launch.ts";
import { TEMPORARY_FLEET_WRITABLE } from "../src/containment/agent-profile.ts";
import type { ReadOnlyAgentRole } from "../src/containment/role-profiles.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { type CageConfig, cagedSteps } from "./support/caged-launch.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * Fake agents in every read-only role, under real bwrap and through the real
 * compile, probe, gate and launch. Only the systemd layer is a stand-in.
 *
 * Every agent starts with a guard that exits 99, having done nothing, unless it
 * is plainly inside the sandbox. Destructive commands name fixture paths only.
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
const skip = liveGate("role-sandbox-live", skipReason());

const ROLES: ReadOnlyAgentRole[] = [
	"reviewer",
	"plan",
	"import",
	"trigger",
	"brain",
];

const toolDirs = () =>
	["sh", "cat", "ls", "rm", "touch", "mkdir", "grep", "env", "sleep", "mv"]
		.map((t) => Bun.which(t))
		.filter((p): p is string => !!p)
		.map((p) => dirname(realpathSync(p)));

describe.skipIf(skip !== null)("read-only agent roles", () => {
	let base: string;
	let home: string;
	let mfwHome: string;
	let project: string;
	let stateDir: string;
	let tree: string;
	let gitDir: string;
	let bin: string;
	let cage: CageConfig;
	let handle: ProjectDbHandle;
	let egressDir: string;
	let egressHits = 0;
	let egress: net.Server;
	let brainDir: string;
	let brainHits = 0;
	let brain: ReturnType<typeof Bun.serve>;
	let otherBrainDir: string;
	let victim: ReturnType<typeof Bun.spawn>;
	let seq = 0;

	const fleet = () => join(mfwHome, "agents/claude");

	const assertOutsideIntact = () => {
		expect(readFileSync(join(home, ".ssh/id_canary"), "utf8")).toBe("key\n");
		expect(readFileSync(join(project, "primary.txt"), "utf8")).toBe("p\n");
		expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("tree\n");
		expect(readFileSync(join(gitDir, "HEAD"), "utf8")).toContain("ref:");
		expect(readFileSync(join(fleet(), "settings.json"), "utf8")).toBe("{}\n");
		expect(readFileSync(join(otherBrainDir, "token"), "utf8")).toBe("other\n");
	};

	const guard = () => `
[ "$HOME" = /sandbox/agent ] || exit 99
[ "$(pwd)" = /work ] || exit 99
for p in '${home}/.ssh' '${mfwHome}' '${project}'; do [ ! -e "$p" ] || exit 99; done
if touch /mfw-not-contained 2>/dev/null; then exit 99; fi
`;

	async function run(role: ReadOnlyAgentRole, body: string, network = true) {
		const runId = `role-${role}-${++seq}`;
		const runDir = join(stateDir, "runs", runId);
		ensureRunDirLayout(runDir);
		const agent = join(bin, "claude");
		writeFileSync(
			agent,
			`#!/bin/sh\n${guard()}\nR=/mfw-run/outbox/result\n: > "$R"\n${body}\nexit 0\n`,
		);
		chmodSync(agent, 0o755);
		const req: AgentLaunchRequest = {
			version: 1,
			runId,
			role,
			approvalMode: "autonomous",
			cli: "claude",
			tree,
			runDir,
			projectRoot: project,
			stateDir,
			mfwHome,
			env: { MFW_RUN_ID: runId },
			secretNames: [],
			...(network ? { egressSocketDir: egressDir } : {}),
			...(role === "brain" ? { brainSocketDir: brainDir } : {}),
		};
		const launched = await launchAgentSandbox(req, ["claude"], {
			...cagedSteps(cage),
			db: handle.db,
			secretValue: () => undefined,
			warn: () => {},
		});
		if (!launched.ok) {
			throw new Error(`refused: ${launched.code}: ${launched.reason}`);
		}
		const { child } = launched;
		(child.stdin as unknown as { end(): void }).end();
		const [stderr, code] = await Promise.all([
			new Response(child.stderr as never).text(),
			child.exited,
			new Response(child.stdout as never).text(),
		]);
		const path = join(runDir, "outbox/result");
		const result = existsSync(path) ? readFileSync(path, "utf8") : "";
		return { code, result, stderr };
	}

	beforeAll(async () => {
		mkdirSync(FIXTURES, { recursive: true });
		base = realpathSync(mkdtempSync(join(FIXTURES, "roles-")));
		home = join(base, "home");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(join(home, ".ssh/id_canary"), "key\n");
		mfwHome = join(base, "mfw");
		for (const rel of TEMPORARY_FLEET_WRITABLE.claude) {
			mkdirSync(join(mfwHome, "agents/claude", rel), { recursive: true });
		}
		writeFileSync(join(mfwHome, "agents/claude/settings.json"), "{}\n");
		const clone = join(mfwHome, "workspaces/ro-fixture");
		tree = join(clone, "tree");
		gitDir = join(clone, "git");
		mkdirSync(tree, { recursive: true });
		mkdirSync(gitDir);
		writeFileSync(join(tree, "a.txt"), "tree\n");
		writeFileSync(join(clone, "mfw-workspace.json"), "{}");
		Bun.spawnSync([
			GIT as string,
			"--git-dir",
			gitDir,
			"init",
			"-q",
			"--template=",
		]);
		project = join(base, "project");
		stateDir = join(project, ".mfw");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(project, "primary.txt"), "p\n");
		handle = await openProjectDb(stateDir);
		// A home toolchain root, the one place a CLI may live under the home.
		bin = join(home, ".local/bin");
		mkdirSync(bin, { recursive: true });
		const shim = join(base, "systemd-run-shim");
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
		egressDir = join(mfwHome, "run/s/fixture");
		mkdirSync(egressDir, { recursive: true, mode: 0o700 });
		egress = net.createServer((s) => {
			egressHits++;
			s.destroy();
		});
		await new Promise<void>((r) => egress.listen(join(egressDir, "e.sock"), r));
		brainDir = join(mfwHome, "run/b/turn");
		otherBrainDir = join(mfwHome, "run/b/other");
		mkdirSync(brainDir, { recursive: true, mode: 0o700 });
		mkdirSync(otherBrainDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(brainDir, "token"), "turn\n");
		writeFileSync(join(otherBrainDir, "token"), "other\n");
		brain = Bun.serve({
			unix: join(brainDir, "brain.sock"),
			fetch: () => {
				brainHits++;
				return new Response("brain-ok");
			},
		});
		victim = Bun.spawn(["sleep", "120"], {
			stdout: "ignore",
			stderr: "ignore",
		});
	});

	afterAll(async () => {
		victim.kill();
		await brain.stop(true);
		await new Promise<void>((r) => egress.close(() => r()));
		handle.close();
		rmSync(base, { recursive: true, force: true });
	});

	describe.each(ROLES)("%s", (role) => {
		test("positive control: reads its workspace and reports to the outbox", async () => {
			assertOutsideIntact();
			const r = await run(role, 'cat /work/a.txt >> "$R"; echo ok >> "$R"');
			expect(r.code).toBe(0);
			expect(r.result).toBe("tree\nok\n");
		}, 30_000);

		test("cannot write the workspace, gitdir, control or shared config", async () => {
			const r = await run(
				role,
				`for p in /work/x /work/a.txt /git/HEAD /git/hooks/post-merge /mfw-run/control/x "$CLAUDE_CONFIG_DIR/settings.json" "$CLAUDE_CONFIG_DIR/x"; do
  if ( : >> "$p" ) 2>/dev/null; then echo "WROTE $p" >> "$R"; fi
done; echo done >> "$R"`,
			);
			expect(r.code).toBe(0);
			expect(r.result).toBe("done\n");
			assertOutsideIntact();
		}, 30_000);

		test("a destructive command changes nothing outside", async () => {
			const r = await run(
				role,
				`rm -rf /work/* /git/* "${home}/$UNSET" "${project}/$UNSET" "${mfwHome}/$UNSET" 2>/dev/null; echo ran >> "$R"`,
			);
			expect(r.code).toBe(0);
			expect(r.result).toBe("ran\n");
			assertOutsideIntact();
		}, 30_000);

		test("a session write lands in private state, never the shared config", async () => {
			const r = await run(
				role,
				'echo s > "$CLAUDE_CONFIG_DIR/projects/mark" && echo wrote >> "$R"',
			);
			expect(r.result).toBe("wrote\n");
			expect(readdirSync(join(fleet(), "projects"))).toEqual([]);
			expect(
				readFileSync(
					join(dirname(tree), "fleet-state/claude/projects/mark"),
					"utf8",
				),
			).toBe("s\n");
			rmSync(join(dirname(tree), "fleet-state/claude/projects/mark"));
		}, 30_000);

		test("sees no host state and cannot signal a host process", async () => {
			const r = await run(
				role,
				`for p in /var/log/journal /run/log/journal /nix/var/nix/daemon-socket /run/user/${process.getuid?.()} /tmp/tmux-${process.getuid?.()} /tmp/mfw-control-${process.getuid?.()}; do
  if [ -e "$p" ] && [ -n "$(ls -A "$p" 2>/dev/null)" ]; then echo "VISIBLE $p" >> "$R"; fi
done
kill -9 ${victim.pid} 2>/dev/null && echo KILLED >> "$R"; echo done >> "$R"`,
			);
			expect(r.result).toBe("done\n");
			expect(victim.exitCode).toBeNull();
		}, 30_000);
	});

	test("only the brain gets the brain socket, and only its own turn's", async () => {
		const before = brainHits;
		const script = `const r = await fetch("http://x/", { unix: "/run/mfw/brain/brain.sock" }); console.log(await r.text());`;
		const r = await run(
			"brain",
			`bun --config=/dev/null --no-env-file -e '${script}' >> "$R" 2>&1
ls /run/mfw/brain | sort | tr '\\n' ' ' >> "$R"
[ -e /run/mfw/other ] && echo SIBLING >> "$R"; true`,
		);
		expect(r.result).toBe("brain-ok\nbrain.sock token ");
		expect(brainHits).toBe(before + 1);
		const plan = await run("plan", 'ls /run/mfw >> "$R"');
		expect(plan.result).toBe("egress\n");
	}, 40_000);

	test("the brain socket is refused for any other role", async () => {
		const runDir = join(stateDir, "runs/role-refuse");
		ensureRunDirLayout(runDir);
		const r = await launchAgentSandbox(
			{
				version: 1,
				runId: "role-refuse",
				role: "plan",
				approvalMode: "autonomous",
				cli: "claude",
				tree,
				runDir,
				projectRoot: project,
				stateDir,
				mfwHome,
				env: {},
				secretNames: [],
				brainSocketDir: brainDir,
			},
			["claude"],
			{
				...cagedSteps(cage),
				db: handle.db,
				secretValue: () => undefined,
				warn: () => {},
			},
		);
		expect(r.ok).toBe(false);
	});

	test("without a network the role runs with no runtime and no route", async () => {
		const before = egressHits;
		const r = await run(
			"trigger",
			`command -v bun >/dev/null && echo HAS-BUN >> "$R"
[ -e /run/mfw/egress ] && echo HAS-EGRESS >> "$R"
[ -e /run/mfw/brain ] && echo HAS-BRAIN >> "$R"
grep -qv lo /proc/net/route 2>/dev/null; echo done >> "$R"`,
			false,
		);
		expect(r.code).toBe(0);
		expect(r.result).toBe("done\n");
		expect(egressHits).toBe(before);
	}, 30_000);
});
