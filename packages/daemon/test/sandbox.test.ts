import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { bwrapAvailable, wrapWithBwrap } from "../src/sandbox.ts";

/**
 * MFW-33 item 3: filesystem isolation.
 *
 * `wrapWithBwrap` is tested as a pure function (the exact flags matter, a
 * wrong order silently un-hides the one path this exists to hide). The
 * end-to-end test below only runs where `bwrap` is actually installed, same
 * as the feature itself degrades: skipped, not failed, when it is not.
 */

async function waitFor(
	cond: () => Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await cond()) return;
		await Bun.sleep(50);
	}
	throw new Error("waitFor timed out");
}

describe("wrapWithBwrap", () => {
	test("hides paths AFTER the writable binds, so a hidden path under a writable one still overlays it", () => {
		const wrapped = wrapWithBwrap("echo hi", "/work/wt", "/work/run", {
			mode: "bwrap",
			hidePaths: ["/home/x/.local/share/mfw"],
		});
		const bindIdx = wrapped.indexOf("'/work/wt' '/work/wt'");
		const tmpfsIdx = wrapped.indexOf("--tmpfs '/home/x/.local/share/mfw'");
		expect(bindIdx).toBeGreaterThan(-1);
		expect(tmpfsIdx).toBeGreaterThan(bindIdx);
	});

	test("binds cwd, run dir and $HOME read-write; leaves the rest read-only via the base bind", () => {
		const wrapped = wrapWithBwrap("echo hi", "/work/wt", "/work/run", {
			mode: "bwrap",
			hidePaths: [],
		});
		expect(wrapped).toContain("--ro-bind / /");
		expect(wrapped).toContain("--bind '/work/wt' '/work/wt'");
		expect(wrapped).toContain("--bind '/work/run' '/work/run'");
		expect(wrapped).toStartWith("bwrap --die-with-parent");
		expect(wrapped).toContain("-- sh -c 'echo hi'");
	});

	test("never unshares the network: an agent still needs it", () => {
		const wrapped = wrapWithBwrap("echo hi", "/work/wt", "/work/run", {
			mode: "bwrap",
			hidePaths: [],
		});
		expect(wrapped).not.toContain("--unshare-net");
	});

	test("single-quotes are escaped so a path cannot break out of the wrapper", () => {
		const wrapped = wrapWithBwrap("echo hi", "/wo'rk", "/work/run", {
			mode: "bwrap",
			hidePaths: [],
		});
		expect(wrapped).toContain("'/wo'\\''rk'");
	});
});

describe("bwrapAvailable", () => {
	test("is a stable boolean across repeated calls (cached)", async () => {
		const a = await bwrapAvailable();
		const b = await bwrapAvailable();
		expect(a).toBe(b);
		expect(typeof a).toBe("boolean");
	});
});

describe("end-to-end: the hidden path is actually invisible under bwrap", () => {
	test("a marker file under a hidden path is unreadable from inside the sandbox; cwd and run dir still work", async () => {
		if (!(await bwrapAvailable())) return; // degrades elsewhere; nothing to prove here

		const base = await mkdtemp(join(tmpdir(), "mfw-sandbox-"));
		const runDir = join(base, "run");
		const cwd = join(base, "wt");
		const hidden = join(base, "mfw-home");
		await mkdir(runDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		await mkdir(hidden, { recursive: true });
		await writeFile(join(hidden, "credentials.json"), '{"secret":true}');
		await writeFile(join(cwd, "visible.txt"), "hello");

		const driverScript = join(base, "driver.ts");
		await writeFile(
			driverScript,
			`
const dir = process.argv[2];
const fs = require("node:fs");
const hidden = ${JSON.stringify(join(hidden, "credentials.json"))};
const visible = ${JSON.stringify(join(cwd, "visible.txt"))};
console.log("hidden-readable:" + fs.existsSync(hidden));
console.log("visible-readable:" + fs.existsSync(visible));
process.exit(0);
`,
		);

		const host = new AgentHost();
		const runId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		await host.launch({
			runId,
			runDir,
			cwd,
			projectRoot: base,
			driverScript,
			agentArgv: ["true"],
			env: {},
			model: "test-model",
			initialMessage: "",
			steer: false,
			isolation: { mode: "bwrap", hidePaths: [hidden] },
		});
		await waitFor(async () => (await host.readExit(runDir)).kind === "exit");
		const raw = await readFile(join(runDir, "raw.log"), "utf8");
		expect(raw).toContain("hidden-readable:false");
		expect(raw).toContain("visible-readable:true");
		await rm(base, { recursive: true, force: true });
	});

	test("without isolation, the same path IS visible, the control", async () => {
		const base = await mkdtemp(join(tmpdir(), "mfw-sandbox-ctrl-"));
		const runDir = join(base, "run");
		const cwd = join(base, "wt");
		const hidden = join(base, "mfw-home");
		await mkdir(runDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		await mkdir(hidden, { recursive: true });
		await writeFile(join(hidden, "credentials.json"), "{}");

		const driverScript = join(base, "driver.ts");
		await writeFile(
			driverScript,
			`
const fs = require("node:fs");
console.log("hidden-readable:" + fs.existsSync(${JSON.stringify(join(hidden, "credentials.json"))}));
process.exit(0);
`,
		);

		const host = new AgentHost();
		const runId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		await host.launch({
			runId,
			runDir,
			cwd,
			projectRoot: base,
			driverScript,
			agentArgv: ["true"],
			env: {},
			model: "test-model",
			initialMessage: "",
			steer: false,
			// no isolation
		});
		await waitFor(async () => (await host.readExit(runDir)).kind === "exit");
		const raw = await readFile(join(runDir, "raw.log"), "utf8");
		expect(raw).toContain("hidden-readable:true");
		await rm(base, { recursive: true, force: true });
	});
});

// `agent-host-isolation-degrade.test.ts` covers what happens when `bwrap` is
// unavailable: a separate file because mocking `./sandbox.ts` there would
// otherwise leak into this file's real, unmocked `bwrapAvailable` calls.
