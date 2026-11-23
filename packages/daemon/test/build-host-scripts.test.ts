import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveScript } from "../src/agents/adapter.ts";
import {
	AGENT_LAUNCHER,
	BUILT_HOST_SCRIPTS,
	builtScriptName,
	CLAUDE_BRIDGE,
	EGRESS_RELAY,
	HOST_SCRIPTS_DIR,
	hostScript,
	sha256Hex,
} from "../src/containment/host-script.ts";
import { sourceRunRefusal } from "../src/containment/source-run-guard.ts";
import { git } from "../src/git.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("the built host scripts", () => {
	let base: string;
	let output: string;
	let chunk: string;

	beforeAll(async () => {
		base = mkdtempSync(join(tmpdir(), "mfw-built-scripts-"));
		output = join(base, "repo/apps/start/.output");
		mkdirSync(join(output, "server/chunks"), { recursive: true });
		chunk = pathToFileURL(join(output, "server/chunks/router.mjs")).href;
		// In its own process, as in a real build: Bun.build is unreliable inside
		// the test runner.
		const built = Bun.spawnSync(
			[process.execPath, join(repoRoot, "tools/build-host-scripts.ts"), output],
			{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
		);
		if (built.exitCode !== 0) throw new Error(built.stderr.toString());
	}, 60_000);
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	test("every script is built, listed and resolves to its verified copy", () => {
		for (const script of BUILT_HOST_SCRIPTS) {
			const path = hostScript(chunk, script);
			expect(path).toBe(
				join(output, HOST_SCRIPTS_DIR, builtScriptName(script)),
			);
		}
	});

	test("a built script imports nothing relative, so nothing loads from the checkout", () => {
		for (const script of BUILT_HOST_SCRIPTS) {
			const text = readFileSync(hostScript(chunk, script), "utf8");
			expect(text).not.toMatch(/^import [^\n]*from "\.\.?\//m);
		}
	});

	test("a fake merge over the source leaves the launch on the built copy", () => {
		const checkout = join(base, "repo");
		const source = join(checkout, AGENT_LAUNCHER.fromRoot);
		mkdirSync(dirname(source), { recursive: true });
		writeFileSync(source, "throw new Error('agent-authored');\n");
		const before = readFileSync(hostScript(chunk, AGENT_LAUNCHER));
		const resolved = hostScript(chunk, AGENT_LAUNCHER);
		expect(resolved.startsWith(output)).toBe(true);
		expect(readFileSync(resolved)).toEqual(before);
		expect(readFileSync(resolved, "utf8")).not.toContain("agent-authored");
	});

	test("the production server refuses a script override", () => {
		const fake = join(base, "fake-bridge.ts");
		writeFileSync(fake, "// fake\n");
		process.env.MFW_TEST_BRIDGE_OVERRIDE = fake;
		try {
			expect(() =>
				resolveScript(chunk, CLAUDE_BRIDGE, "MFW_TEST_BRIDGE_OVERRIDE"),
			).toThrow(/refusing MFW_TEST_BRIDGE_OVERRIDE/);
		} finally {
			delete process.env.MFW_TEST_BRIDGE_OVERRIDE;
		}
	});

	test("a rebuilt copy elsewhere keeps verifying (the deploy swap renames the output)", () => {
		const moved = join(base, "moved/apps/start/.output");
		cpSync(output, moved, { recursive: true });
		const url = pathToFileURL(join(moved, "server/chunks/router.mjs")).href;
		const path = hostScript(url, EGRESS_RELAY);
		expect(path.startsWith(moved)).toBe(true);
		expect(sha256Hex(readFileSync(path)).length).toBe(64);
	});
});

describe("running from source", () => {
	const moduleUrl = pathToFileURL(
		join(repoRoot, "packages/daemon/src/boot.ts"),
	).href;

	test("an unrelated project may attach", async () => {
		const other = mkdtempSync(join(tmpdir(), "mfw-source-guard-"));
		try {
			await git(["init", "-q"], other);
			expect(await sourceRunRefusal(moduleUrl, other)).toBeNull();
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	test("the server's own repository is refused, with the fix", async () => {
		const refusal = await sourceRunRefusal(moduleUrl, repoRoot);
		expect(refusal).toContain("refusing to attach");
		expect(refusal).toContain("bun run build");
	});

	test("the production build is not subject to the source guard", async () => {
		const bundled = pathToFileURL(
			join(repoRoot, "apps/start/.output/server/chunks/router.mjs"),
		).href;
		expect(await sourceRunRefusal(bundled, repoRoot)).toBeNull();
	});
});
