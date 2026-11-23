import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentProfileError,
	autonomyFlags,
	buildRunProfile,
	cloneLayout,
	findLaunchSecret,
	findWritableBindParent,
	TEMPORARY_FLEET_WRITABLE,
	UNATTESTED_CONFIG_MARKER,
	withoutAutonomyFlags,
} from "../src/containment/agent-profile.ts";
import type { PinnedBind } from "../src/containment/pinned-binds.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";

let base: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-agent-profile-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function clone(id = "r1"): string {
	const dir = join(base, "workspaces", id);
	mkdirSync(join(dir, "tree"), { recursive: true });
	mkdirSync(join(dir, "git"));
	writeFileSync(join(dir, "mfw-workspace.json"), "{}");
	return join(dir, "tree");
}

const bind = (source: string, writable: boolean, i = 0): PinnedBind => ({
	fd: 5 + i,
	source,
	dest: `/d${i}`,
	writable,
	label: `bind ${i}`,
});

describe("cloneLayout", () => {
	test("accepts a seeded clone and returns its gitdir", () => {
		const tree = clone();
		expect(cloneLayout(tree).gitDir).toBe(join(base, "workspaces/r1/git"));
	});

	test("refuses a plain worktree path", () => {
		const tree = join(base, "worktrees/r1");
		mkdirSync(tree, { recursive: true });
		expect(() => cloneLayout(tree)).toThrow(AgentProfileError);
	});

	test("refuses a gitdir that is a symlink", () => {
		const tree = clone("r2");
		const git = join(base, "workspaces/r2/git");
		rmSync(git, { recursive: true });
		symlinkSync(join(base, "elsewhere"), git);
		expect(() => cloneLayout(tree)).toThrow(AgentProfileError);
	});
});

describe("buildRunProfile", () => {
	const input = () => ({
		role: "task" as const,
		tree: clone(),
		runDir: join(base, "runs/r1"),
		cli: "claude" as const,
		fleetDir: join(base, "agents/claude"),
		binaries: ["bun", "git", "claude"],
		env: { MFW_RUN_ID: "r1" },
	});

	test("binds the clone rw, the outbox rw, and no network without a proxy", () => {
		const p = buildRunProfile(input());
		expect(p.filesystem?.workspace?.access).toBe("rw");
		expect(p.filesystem?.workspace?.gitDir).toBe(
			join(base, "workspaces/r1/git"),
		);
		expect(p.filesystem?.runDir?.outbox).toBe("rw");
		expect(p.network).toEqual({ mode: "none" });
		expect(p.home).toBe("synthetic");
		expect(() => parseSandboxProfile(p)).not.toThrow();
	});

	test("uses the temporary allowlist, under its loud marker", () => {
		const p = buildRunProfile(input());
		expect(p.filesystem?.fleetConfig?.writable).toEqual([
			...TEMPORARY_FLEET_WRITABLE.claude,
		]);
		expect(UNATTESTED_CONFIG_MARKER).toBe("unattested-config");
	});

	test("takes egress only from the proxy seam", () => {
		const p = buildRunProfile({
			...input(),
			egressSocketDir: join(base, "egress"),
		});
		expect(p.network).toEqual({
			mode: "proxy",
			socketDir: join(base, "egress"),
		});
	});

	test("an env name off the allowlist is rejected, never dropped", () => {
		expect(() =>
			buildRunProfile({ ...input(), env: { LD_PRELOAD: "/x.so" } }),
		).toThrow();
	});
});

describe("findWritableBindParent", () => {
	test("passes sibling binds", () => {
		expect(
			findWritableBindParent([
				bind("/m/w/r1/tree", true, 0),
				bind("/m/w/r1/git", true, 1),
			]),
		).toBeNull();
	});

	test("passes writable children of a read-only parent", () => {
		expect(
			findWritableBindParent([
				bind("/m/agents/claude", false, 0),
				bind("/m/agents/claude/sessions", true, 1),
			]),
		).toBeNull();
	});

	test("refuses a writable bind that holds another bind source", () => {
		const hit = findWritableBindParent([
			bind("/m/cache", true, 0),
			bind("/m/cache/shared/a", false, 1),
		]);
		expect(hit?.parent.source).toBe("/m/cache");
		expect(hit?.child.source).toBe("/m/cache/shared/a");
	});

	test("refuses a writable fleet dir nested in another writable fleet dir", () => {
		expect(
			findWritableBindParent([
				bind("/f/plugins", true, 0),
				bind("/f/plugins/store", true, 1),
			]),
		).not.toBeNull();
	});
});

describe("findLaunchSecret", () => {
	// Assembled so the private-material check never sees a token-shaped literal.
	const token = ["sk", "ant", "abcdefghijklmnopqrstuvwx"].join("-");
	const clean = {
		argv: ["/opt/bin/claude", "--print"],
		env: { MFW_RUN_ID: "r1" },
		secretValues: [] as string[],
		forbiddenPaths: ["/h/real", "/h/real/.mfw"],
	};

	test("passes a clean launch", () => {
		expect(findLaunchSecret(clean)).toBeNull();
	});

	test("finds a real-home path in argv", () => {
		expect(
			findLaunchSecret({
				...clean,
				argv: ["claude", "--add-dir", "/h/real/.ssh"],
			}),
		).toContain("argv");
	});

	test("does not confuse a sibling path with the real home", () => {
		expect(
			findLaunchSecret({ ...clean, argv: ["claude", "/h/realm/x"] }),
		).toBeNull();
	});

	test("finds an MFW_HOME path in the env", () => {
		expect(
			findLaunchSecret({
				...clean,
				env: { MFW_REPORT_PATH: "/h/real/.mfw/runs/r1" },
			}),
		).toContain("MFW_REPORT_PATH");
	});

	test("finds a granted secret's value in argv", () => {
		expect(
			findLaunchSecret({
				...clean,
				argv: ["claude", `--key=${token}`],
				secretValues: [token],
			}),
		).toContain("argv");
	});

	test("finds a token-shaped value without being told about it", () => {
		expect(
			findLaunchSecret({ ...clean, env: { MFW_PROJECT: token } }),
		).toContain("MFW_PROJECT");
	});

	test("never echoes the secret in its answer", () => {
		const found = findLaunchSecret({
			...clean,
			argv: ["claude", token],
			secretValues: [token],
		});
		expect(found).not.toContain(token);
	});

	test("a toolchain binary in the real home is allowed as argv[0] only", () => {
		const bin = "/h/real/.bun/bin/bun";
		expect(
			findLaunchSecret({ ...clean, argv: [bin, "x"], allowedArgv0: bin }),
		).toBeNull();
		expect(
			findLaunchSecret({ ...clean, argv: ["x", bin], allowedArgv0: bin }),
		).toContain("argv");
	});
});

describe("autonomy flags", () => {
	test("are found and stripped", () => {
		const argv = ["claude", "--print", "--dangerously-skip-permissions"];
		expect(autonomyFlags(argv)).toEqual(["--dangerously-skip-permissions"]);
		expect(withoutAutonomyFlags(argv)).toEqual(["claude", "--print"]);
	});

	test("cover codex's bypass flag", () => {
		expect(
			autonomyFlags(["codex", "--dangerously-bypass-approvals-and-sandbox"]),
		).toHaveLength(1);
	});

	test("cover the inline form of a flag", () => {
		expect(
			autonomyFlags(["claude", "--dangerously-skip-permissions=true"]),
		).toHaveLength(1);
	});
});
