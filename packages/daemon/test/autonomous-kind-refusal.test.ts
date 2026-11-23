import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHost,
	type AgentTmuxRunner,
	type LaunchSpec,
} from "../src/agent-host.ts";
import { DispatchPreflightError } from "../src/dispatch-preflight.ts";
import { refusalFix } from "../src/refusal-fix.ts";
import { RunEngine } from "../src/run-engine.ts";
import { controlRootPath, SandboxUnavailableError } from "../src/sandbox.ts";

/**
 * Security review P5b, M4: plan, import, action and brain runs still use the
 * interim sandbox, which binds the real home read-write. They may not run
 * autonomously until their role profiles exist.
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

describe("M4: the agent host", () => {
	test.each([...KINDS])("refuses an autonomous %s run", async (runKind) => {
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await expect(
			host.launch(spec(`m4-${runKind}-${process.pid}`, { runKind })),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(calls).toEqual([]);
	});

	test("refuses an autonomous launch that names no kind", async () => {
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await expect(
			host.launch(spec(`m4-none-${process.pid}`, {})),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(calls).toEqual([]);
	});

	test.each([
		...KINDS,
	])("leaves an interactive %s run as it was", async (runKind) => {
		const runId = `m4-int-${runKind}-${process.pid}`;
		const host = new AgentHost(undefined, {
			tmuxRunner: runner,
			sandbox: {
				bwrapAvailable: async () => true,
				wrapWithBwrap: (cmd: string) => cmd,
			},
		});
		try {
			await host.launch(spec(runId, { runKind, approvalMode: "interactive" }));
			expect(calls.some((c) => c[0] === "new-session")).toBe(true);
		} finally {
			rmSync(join(controlRootPath(), `run-${runId}.sh`), { force: true });
		}
	});
});

describe("M4: the engine refuses before preparing anything", () => {
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

	test.each([...KINDS])("%s is a preflight refusal with a fix", (kind) => {
		let thrown: unknown;
		try {
			engine("autonomous").assertKindMayRun(kind);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(DispatchPreflightError);
		const err = thrown as DispatchPreflightError;
		expect(err.code).toBe("sandbox_role_unavailable");
		expect(err.fix.text).toContain("interactive");
		expect(err.fix.text).not.toContain("agentIsolation none");
	});

	test.each(["task", "repair"])("%s may run", (kind) => {
		expect(() => engine("autonomous").assertKindMayRun(kind)).not.toThrow();
	});

	test.each([...KINDS])("an interactive %s may run", (kind) => {
		expect(() => engine("interactive").assertKindMayRun(kind)).not.toThrow();
	});

	test("the refusal names the run kind", () => {
		expect(refusalFix("sandbox_role_unavailable", ["plan"]).text).toContain(
			"plan",
		);
	});
});
