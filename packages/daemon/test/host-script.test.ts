import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AGENT_LAUNCHER,
	EGRESS_PROXY,
	EGRESS_RELAY,
	hostScript,
	WIP_HELPER,
} from "../src/containment/host-script.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("host-side scripts in the bundled server (review F5)", () => {
	let root: string;
	const write = (rel: string) => {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "// fixture\n");
		return path;
	};
	const url = (rel: string) => pathToFileURL(join(root, rel)).href;
	const CHUNK = "repo/apps/start/.output/server/chunks/_/router.mjs";
	const script = {
		file: "x-main.ts",
		fromRoot: "packages/daemon/src/x-main.ts",
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mfw-host-script-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("every script names a real file in the checkout", () => {
		for (const s of [AGENT_LAUNCHER, EGRESS_PROXY, EGRESS_RELAY, WIP_HELPER])
			expect(Bun.file(join(repoRoot, s.fromRoot)).size).toBeGreaterThan(0);
	});

	test("from source, the file beside the module wins", () => {
		const beside = write("src/x-main.ts");
		expect(hostScript(url("src/module.ts"), script)).toBe(beside);
	});

	test("from the bundle, it resolves in the bundle's own checkout", () => {
		const real = write("repo/packages/daemon/src/x-main.ts");
		expect(hostScript(url(CHUNK), script)).toBe(real);
	});

	test("a copy in an agent-writable working directory is never used", () => {
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "packages/daemon/src"), { recursive: true });
		writeFileSync(join(workspace, script.fromRoot), "// planted\n");
		const before = process.cwd();
		process.chdir(workspace);
		try {
			expect(() => hostScript(url(CHUNK), script)).toThrow(/cannot locate/);
		} finally {
			process.chdir(before);
		}
	});

	test("outside a checkout it refuses instead of searching upward", () => {
		write("packages/daemon/src/x-main.ts");
		expect(() => hostScript(url("elsewhere/deep/module.mjs"), script)).toThrow(
			/cannot locate/,
		);
	});
});
