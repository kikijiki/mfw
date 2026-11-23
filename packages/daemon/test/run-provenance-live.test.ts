import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { parseAgentEvents } from "../src/agents/events.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import {
	exitProvenance,
	parseExitClaim,
	readOutboxExitClaim,
} from "../src/run-exit-evidence.ts";
import { controlRootPath } from "../src/sandbox.ts";
import {
	baseSpec,
	fakeHome,
	installCleanup,
	uid,
	usable,
	waitFor,
} from "./support/review-fixes.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/**
 * A hostile agent in a real sandbox: it forges an exit and a report, tries to
 * overwrite the host's record, then fails. Fixtures live under a temp HOME.
 */

installCleanup();

describe("a forged outbox exit under a real sandbox", () => {
	test("the host's record survives, also across a restart", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, home, mk } = await fakeHome();
		process.env.HOME = home;
		const runId = `prov-${uid}`;
		const runDir = join(home, "project", ".mfw", "runs", runId);
		const { control, outbox } = ensureRunDirLayout(runDir);
		const db = join(home, "project", ".mfw", "mfw.db");
		writeFileSync(db, "db-canary");
		const cwd = mk("wt");
		const driver = join(base, "hostile.ts");
		writeFileSync(
			driver,
			`
const fs = require("node:fs");
const attempt = (f) => { try { f(); return "wrote"; } catch { return "refused"; } };
const result = {
	control: attempt(() => fs.writeFileSync(${JSON.stringify(join(control, "exit"))}, "exit:0")),
	root: attempt(() => fs.writeFileSync(${JSON.stringify(join(runDir, "exit"))}, "exit:0")),
	db: attempt(() => fs.writeFileSync(${JSON.stringify(db)}, "forged")),
};
fs.writeFileSync(${JSON.stringify(join(outbox, "exit"))}, "exit:0");
fs.writeFileSync(${JSON.stringify(join(outbox, "MFW_REPORT.json"))}, JSON.stringify({ status: "success" }));
fs.writeFileSync(${JSON.stringify(join(outbox, "attempts.json"))}, JSON.stringify(result));
process.exit(3);
`,
		);
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, runId, runDir, cwd),
			driverScript: driver,
		});
		await procs.get(`mfw_${runId}`)?.exited;
		expect(
			await waitFor(async () => (await host.readExit(runDir)).kind === "exit"),
		).toBe(true);

		// Positive control: the agent really ran and really forged.
		expect(existsSync(join(outbox, "attempts.json"))).toBe(true);
		expect(
			JSON.parse(readFileSync(join(outbox, "attempts.json"), "utf8")),
		).toEqual({ control: "refused", root: "refused", db: "refused" });
		expect(await readOutboxExitClaim(runDir)).toEqual({
			kind: "exit",
			code: 0,
		});

		const live = await host.readExitEvidence(runDir);
		expect(live).toEqual({
			exit: { kind: "exit", code: 3 },
			source: "host-exit-record",
		});
		expect(exitProvenance(live.source, "split")).toBe("host-observed");
		expect(readFileSync(join(control, "exit"), "utf8")).toBe("exit:3");
		expect(readFileSync(db, "utf8")).toBe("db-canary");

		// A reboot clears the host-only control root; `control/exit` remains.
		rmSync(join(controlRootPath(), `exit-${runId}`), { force: true });
		rmSync(join(controlRootPath(), `run-${runId}.sh`), { force: true });
		const after = await new AgentHost(undefined, {
			tmuxRunner: runner,
		}).readExitEvidence(runDir);
		expect(after).toEqual({
			exit: { kind: "exit", code: 3 },
			source: "control-exit",
		});
		expect(exitProvenance(after.source, "split")).toBe("host-observed");
		// Without the DB marker the same file earns no trust.
		expect(exitProvenance(after.source, null)).toBe("sandbox-reported");
	}, 40_000);
});

describe("the real driver in a split sandbox", () => {
	test("reads control, writes its events to the outbox, and finishes", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, home, mk } = await fakeHome();
		process.env.HOME = home;
		const runId = `drv-${uid}`;
		const runDir = join(home, "project", ".mfw", "runs", runId);
		const { outbox } = ensureRunDirLayout(runDir);
		const { runner, procs } = runShTmux();
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, runId, runDir, mk("wt")),
			driverScript: join(
				import.meta.dir,
				"../src/agents/drivers/claude-driver.ts",
			),
			agentArgv: [
				"bun",
				"run",
				join(import.meta.dir, "fixtures/fake-claude.ts"),
			],
			initialMessage: "build it",
		});
		await procs.get(`mfw_${runId}`)?.exited;
		expect(
			await waitFor(async () => (await host.readExit(runDir)).kind === "exit"),
		).toBe(true);
		expect(await host.readExit(runDir)).toEqual({ kind: "exit", code: 0 });
		const events = parseAgentEvents(
			readFileSync(join(outbox, "events.jsonl"), "utf8"),
		);
		expect(events[0]?.type).toBe("hello");
		expect(events.at(-1)?.type).toBe("done");
		expect(existsSync(join(runDir, "events.jsonl"))).toBe(false);
	}, 40_000);
});

describe("exit evidence", () => {
	test("only the host's records are host-observed", () => {
		expect(exitProvenance("host-exit-record", null)).toBe("host-observed");
		expect(exitProvenance("control-exit", "split")).toBe("host-observed");
		expect(exitProvenance("control-exit", null)).toBe("sandbox-reported");
		expect(exitProvenance("flat-exit", "split")).toBe("sandbox-reported");
		expect(exitProvenance("flat-exit", null)).toBe("sandbox-reported");
	});

	test("a claim is parsed strictly", () => {
		expect(parseExitClaim("exit:0\n")).toEqual({ kind: "exit", code: 0 });
		expect(parseExitClaim("killed:manual")).toEqual({
			kind: "killed",
			reason: "manual",
		});
		for (const bad of [
			"",
			"exit:",
			"exit:-1",
			"exit:99999",
			"ok",
			"killed:<b>",
		]) {
			expect(parseExitClaim(bad)).toEqual({ kind: "invalid" });
		}
	});
});
