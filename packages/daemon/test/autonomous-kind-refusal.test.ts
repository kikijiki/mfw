import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHost,
	type AgentTmuxRunner,
	type LaunchSpec,
} from "../src/agent-host.ts";
import { sandboxRoleOfKind } from "../src/containment/role-profiles.ts";
import { DispatchPreflightError } from "../src/dispatch-preflight.ts";
import { RunEngine } from "../src/run-engine.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";

/**
 * Security review P5b, M4, closed by P7: every kind launches in its own role
 * profile, and a kind without one cannot start. The real launch of each role is
 * in role-sandbox-live.test.ts.
 */

const KINDS = ["plan", "import", "action", "brain"] as const;

let base: string;
let calls: string[][];
const ok = {
	exitCode: 0,
	stdout: "",
	stderr: "",
	timedOut: false,
	truncated: false,
	signalCode: null,
};
const runner: AgentTmuxRunner = async (args) => {
	calls.push(args);
	return ok as never;
};

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-m4-")));
	calls = [];
	mkdirSync(join(base, "run"));
	mkdirSync(join(base, "wt"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const spec = (runId: string, over: Partial<LaunchSpec>): LaunchSpec => ({
	runId,
	runDir: join(base, "run"),
	cwd: join(base, "wt"),
	projectRoot: base,
	driverScript: "/opt/mfw/driver.ts",
	agentArgv: ["claude", "--dangerously-skip-permissions"],
	steer: false,
	approvalMode: "autonomous",
	isolation: { mode: "bwrap", hidePaths: [] },
	...over,
});

const host = () =>
	new AgentHost(undefined, {
		tmuxRunner: runner,
		sandbox: { bwrapAvailable: async () => true },
	});

describe("every kind has a role", () => {
	test.each([
		["task", "task"],
		["repair", "repair"],
		["plan", "plan"],
		["import", "import"],
		["action", "trigger"],
		["brain", "brain"],
	])("%s runs as %s", (kind, role) => {
		expect(sandboxRoleOfKind(kind)).toBe(role as never);
	});

	test.each([
		"session",
		"",
		"constructor",
		"__proto__",
	])("%j has no role", (kind) => {
		expect(sandboxRoleOfKind(kind)).toBeNull();
	});
});

describe("the agent host", () => {
	test("refuses a kind with no role, in either mode", async () => {
		for (const approvalMode of ["autonomous", "interactive"] as const) {
			await expect(
				host().launch(
					spec(`m4-none-${process.pid}`, { runKind: "session", approvalMode }),
				),
			).rejects.toBeInstanceOf(SandboxUnavailableError);
		}
		expect(calls).toEqual([]);
	});

	test("refuses a launch that names no kind", async () => {
		await expect(
			host().launch(spec(`m4-unnamed-${process.pid}`, {})),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(calls).toEqual([]);
	});

	test.each([
		...KINDS,
	])("never starts %s outside its profile when the launch cannot be built", async (runKind) => {
		// No fleet home: the role's launch cannot be prepared, and nothing falls back.
		for (const approvalMode of ["autonomous", "interactive"] as const) {
			await expect(
				host().launch(
					spec(`m4-${runKind}-${process.pid}`, { runKind, approvalMode }),
				),
			).rejects.toBeInstanceOf(SandboxUnavailableError);
		}
		expect(calls).toEqual([]);
	});
});

describe("the engine", () => {
	const engine = (approvalMode: "autonomous" | "interactive") => {
		const e = Object.create(RunEngine.prototype) as {
			deps: unknown;
			assertKindMayRun(kind: string): void;
		};
		e.deps = {
			defaults: { approvalMode },
			isolation: { mode: "bwrap", hidePaths: [] },
		};
		return e;
	};

	test.each(["task", "repair", ...KINDS])("%s may run autonomously", (kind) => {
		expect(() => engine("autonomous").assertKindMayRun(kind)).not.toThrow();
	});

	test("a kind with no role is a preflight refusal with a fix", () => {
		let thrown: unknown;
		try {
			engine("interactive").assertKindMayRun("session");
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(DispatchPreflightError);
		const err = thrown as DispatchPreflightError;
		expect(err.code).toBe("sandbox_role_unavailable");
		expect(err.fix.text).toContain("session");
		// Review P7, m2: a refusal never advises turning the sandbox off.
		expect(err.fix.text).not.toContain("agentIsolation");
	});
});
