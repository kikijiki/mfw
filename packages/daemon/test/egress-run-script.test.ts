import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost, type AgentTmuxRunner } from "../src/agent-host.ts";
import { processStartTicks } from "../src/containment/egress-run.ts";

/** What the generated `run.sh` does around the proxy, run in plain bash. */

let base: string;
let control: string;
const runId = "stop-block";
const children: Bun.Subprocess[] = [];

const noTmux: AgentTmuxRunner = async () =>
	({
		exitCode: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		truncated: false,
		signalCode: null,
	}) as never;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-run-script-")));
	control = join(base, "control");
	mkdirSync(control, { mode: 0o700 });
	mkdirSync(join(base, "project/.mfw/runs", runId), { recursive: true });
	writeFileSync(join(base, "project/.mfw/mfw.db"), "");
	mkdirSync(join(base, "mfw/workspaces", runId, "tree"), { recursive: true });
});

afterEach(() => {
	for (const c of children.splice(0)) c.kill("SIGKILL");
	rmSync(base, { recursive: true, force: true });
});

async function runScript(
	over: { providerId?: string; env?: Record<string, string> } = {},
): Promise<string> {
	await new AgentHost(undefined, {
		tmuxRunner: noTmux,
		controlRoot: control,
	}).launch({
		runId,
		runDir: join(base, "project/.mfw/runs", runId),
		cwd: join(base, "mfw/workspaces", runId, "tree"),
		projectRoot: join(base, "project"),
		driverScript: "/opt/mfw/driver.ts",
		agentArgv: ["claude", "--print"],
		steer: false,
		approvalMode: "interactive",
		isolation: {
			mode: "bwrap",
			hidePaths: [join(base, "mfw")],
			mfwHome: join(base, "mfw"),
		},
		runKind: "task",
		providerId: over.providerId ?? "claude-cli",
		...(over.env ? { env: over.env } : {}),
	});
	return readFileSync(join(control, `run-${runId}.sh`), "utf8");
}

/** The lines between the driver's exit and the exit record. */
function stopBlock(script: string): string {
	const from = script.indexOf("rc=$?");
	const to = script.indexOf('mfw_record_exit "exit:$rc"');
	expect(from).toBeGreaterThan(0);
	return script.slice(from + "rc=$?".length, to);
}

const helper = (script: string) =>
	/^mfw_proc_ticks\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0] ?? "";

describe("what a Codex run may reach", () => {
	const allowed = () =>
		(
			JSON.parse(
				readFileSync(
					join(base, "project/.mfw/runs", runId, "egress/config.json"),
					"utf8",
				),
			) as { allow: { host: string }[] }
		).allow.map((a) => a.host);

	test("a subscription run cannot reach the API host", async () => {
		await runScript({ providerId: "codex-cli" });
		expect(allowed()).toContain("chatgpt.com");
		expect(allowed()).not.toContain("api.openai.com");
	});

	test("a run configured with an API key can", async () => {
		await runScript({
			providerId: "codex-cli",
			env: { OPENAI_API_KEY: "test-value" },
		});
		expect(allowed()).toContain("api.openai.com");
	});
});

describe("stopping the proxy at the end of a run", () => {
	test("a pid reused by another process is never signalled", async () => {
		const script = await runScript();
		const bystander = Bun.spawn(["sleep", "30"]);
		children.push(bystander);
		const before = processStartTicks(bystander.pid);
		expect(before).not.toBeNull();
		// The proxy died and its pid now names this process, with other start ticks.
		const r = Bun.spawnSync(
			[
				"bash",
				"-c",
				`${helper(script)}
exec 8>/dev/null
mfw_egress_pid=${bystander.pid}
mfw_egress_ticks=1
${stopBlock(script)}
exit 0`,
			],
			{ timeout: 15_000 },
		);
		expect(r.exitCode).toBe(0);
		await Bun.sleep(50);
		expect(bystander.killed).toBe(false);
		expect(bystander.exitCode).toBeNull();
		expect(processStartTicks(bystander.pid)).toBe(before);
	}, 30_000);

	test("the stop block sends no signal at all", async () => {
		expect(stopBlock(await runScript())).not.toMatch(/\bkill -(9|KILL|TERM)/);
	});

	test("a proxy whose event loop is stuck still exits by its hard deadline", async () => {
		const module = resolve(import.meta.dir, "../src/containment/egress-run.ts");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { armProxyHardExit } from ${JSON.stringify(module)};
armProxyHardExit(1);
for (;;) {}`,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		children.push(child);
		const outcome = await Promise.race([
			child.exited.then(() => "exited"),
			Bun.sleep(8_000).then(() => "still running"),
		]);
		expect(outcome).toBe("exited");
		expect(child.signalCode).toBe("SIGALRM");
	}, 15_000);
});
