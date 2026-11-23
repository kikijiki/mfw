import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AGENT_LAUNCHER,
	BRAIN_TRANSCRIPT,
	EGRESS_PROXY,
	EGRESS_PROXY_BESIDE,
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
		for (const s of [
			AGENT_LAUNCHER,
			BRAIN_TRANSCRIPT,
			EGRESS_PROXY,
			EGRESS_PROXY_BESIDE,
			EGRESS_RELAY,
			WIP_HELPER,
		])
			expect(Bun.file(join(repoRoot, s.fromRoot)).size).toBeGreaterThan(0);
	});

	test("each script is found from the module that asks for it", () => {
		const src = join(repoRoot, "packages/daemon/src");
		const from = (rel: string) => pathToFileURL(join(src, rel)).href;
		expect(hostScript(from("agent-host.ts"), BRAIN_TRANSCRIPT)).toBe(
			join(repoRoot, BRAIN_TRANSCRIPT.fromRoot),
		);
		expect(
			hostScript(from("containment/oneshot-agent.ts"), EGRESS_PROXY_BESIDE),
		).toBe(join(repoRoot, EGRESS_PROXY.fromRoot));
	});

	test("from source, the file beside the module wins", () => {
		const beside = write("src/x-main.ts");
		expect(hostScript(url("src/module.ts"), script)).toBe(beside);
	});

	/** A built copy of `script` and its manifest, as the build writes them. */
	const build = (content = "// built\n") => {
		const dir = join(root, "repo/apps/start/.output/server/host-scripts");
		mkdirSync(dir, { recursive: true });
		const name = "packages__daemon__src__x-main.js";
		writeFileSync(join(dir, name), content);
		const sha256 = createHash("sha256").update(content).digest("hex");
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ version: 1, scripts: { [name]: sha256 } }),
		);
		return join(dir, name);
	};

	test("from the bundle, it runs the built copy", () => {
		write("repo/packages/daemon/src/x-main.ts");
		const built = build();
		expect(hostScript(url(CHUNK), script)).toBe(built);
	});

	test("a merge that rewrites the source script does not reach the host", () => {
		const source = write("repo/packages/daemon/src/x-main.ts");
		const built = build("// reviewed at build time\n");
		// What an autonomous fast-forward of the checkout does.
		writeFileSync(source, "// agent-authored\n");
		const resolved = hostScript(url(CHUNK), script);
		expect(resolved).toBe(built);
		expect(readFileSync(resolved, "utf8")).toBe("// reviewed at build time\n");
	});

	test("a built copy that no longer matches its hash is refused", () => {
		const built = build();
		writeFileSync(built, "// tampered\n");
		expect(() => hostScript(url(CHUNK), script)).toThrow(
			/hash.*bun run build/s,
		);
	});

	test("a missing manifest is refused, even with the source present", () => {
		write("repo/packages/daemon/src/x-main.ts");
		const built = build();
		rmSync(join(dirname(built), "manifest.json"));
		expect(() => hostScript(url(CHUNK), script)).toThrow(
			/manifest.*bun run build/s,
		);
	});

	test("a script the manifest does not list is refused", () => {
		const built = build();
		writeFileSync(
			join(dirname(built), "manifest.json"),
			JSON.stringify({ version: 1, scripts: {} }),
		);
		expect(() => hostScript(url(CHUNK), script)).toThrow(/not in the manifest/);
	});

	test("a built copy replaced by a symlink is refused", () => {
		const built = build();
		const elsewhere = write("elsewhere.js");
		rmSync(built);
		symlinkSync(elsewhere, built);
		expect(() => hostScript(url(CHUNK), script)).toThrow(/regular file/);
	});

	test("a copy in an agent-writable working directory is never used", () => {
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "packages/daemon/src"), { recursive: true });
		writeFileSync(join(workspace, script.fromRoot), "// planted\n");
		const before = process.cwd();
		process.chdir(workspace);
		try {
			expect(() => hostScript(url(CHUNK), script)).toThrow(/manifest/);
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
