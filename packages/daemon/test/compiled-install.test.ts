import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildKind, isCompiledModuleUrl } from "@mfw/core/build-info";
import { resolveScript } from "../src/agents/adapter.ts";
import {
	AGENT_LAUNCHER,
	APP_SERVER_DRIVER,
	BUILT_HOST_SCRIPTS,
	CLAUDE_BRIDGE,
	EGRESS_RELAY,
	HOST_CONTENT_IDS,
	HOST_ENTRY_IDS,
	HOST_SUBCOMMAND,
	hostArgv,
	hostCommand,
	hostEntry,
	hostScript,
	isHostEntryRef,
	runsHostEntries,
	sha256Hex,
} from "../src/containment/host-script.ts";
import {
	checkInstall,
	INSTALL_MANIFEST,
	INSTALL_MANIFEST_VERSION,
	type InstallManifest,
	installPath,
	readInstallManifest,
	treeDigest,
} from "../src/containment/install-manifest.ts";

/**
 * A compiled install's server bundle, laid out as a checkout build so the
 * bundle is recognised from source: `<root>/repo/apps/start/.output` holds the
 * server and its `install.json`, and `../../bin/mfw` (inside the prefix, the
 * manifest directory's grandparent) is the executable.
 */
describe("a compiled install's server runs host code only through mfw __host", () => {
	let root: string;
	let output: string;
	let chunk: string;
	let mfw: string;
	let manifest: InstallManifest;

	const writeManifest = (m: InstallManifest) =>
		writeFileSync(join(output, INSTALL_MANIFEST), JSON.stringify(m));

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mfw-compiled-install-"));
		output = join(root, "repo/apps/start/.output");
		mkdirSync(join(output, "server/chunks/_"), { recursive: true });
		mkdirSync(join(output, "public"));
		writeFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), "notices\n");
		writeFileSync(join(output, "server/index.mjs"), "// server\n");
		chunk = pathToFileURL(join(output, "server/chunks/_/router.mjs")).href;
		mkdirSync(join(root, "repo/apps/bin"));
		mfw = join(root, "repo/apps/bin/mfw");
		writeFileSync(mfw, "#!/bin/sh\nexit 0\n");
		chmodSync(mfw, 0o755);
		manifest = {
			version: INSTALL_MANIFEST_VERSION,
			kind: "compiled",
			mfw: { path: "../../bin/mfw", sha256: sha256Hex("#!/bin/sh\nexit 0\n") },
			mfwBoard: {
				path: "../../bin/mfw",
				sha256: sha256Hex("#!/bin/sh\nexit 0\n"),
			},
			runtime: {
				path: "../../bin/mfw",
				sha256: sha256Hex("#!/bin/sh\nexit 0\n"),
				bunVersion: "1.3.13",
			},
			server: { digest: treeDigest(output) },
		};
		writeManifest(manifest);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("tests run from source, never as a compiled build", () => {
		expect(buildKind()).toBe("source");
		expect(isCompiledModuleUrl(import.meta.url)).toBe(false);
		expect(isCompiledModuleUrl("file:///$bunfs/root/mfw")).toBe(true);
	});

	test("every host entry and content script has one id, and they do not overlap", () => {
		const ids = BUILT_HOST_SCRIPTS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(
			[...HOST_ENTRY_IDS, ...HOST_CONTENT_IDS].sort(),
		);
	});

	test("an entry becomes `mfw __host <id>` with the install's verified mfw", () => {
		expect(runsHostEntries(chunk)).toBe(true);
		const ref = hostEntry(chunk, APP_SERVER_DRIVER);
		expect(isHostEntryRef(ref)).toBe(true);
		expect(hostCommand(ref, "/bin/bun", chunk)).toEqual([
			mfw,
			HOST_SUBCOMMAND,
			"app-server-driver",
		]);
		expect(
			hostArgv(
				["bun", "run", hostEntry(chunk, CLAUDE_BRIDGE)],
				"/bin/bun",
				chunk,
			),
		).toEqual([mfw, HOST_SUBCOMMAND, "claude-bridge"]);
	});

	test("a script path is refused: the install has no script files to load", () => {
		mkdirSync(join(output, "server/host-scripts"));
		writeFileSync(join(output, "server/host-scripts/manifest.json"), "{}");
		expect(() => hostScript(chunk, AGENT_LAUNCHER)).toThrow(
			/compiled install has no script files/,
		);
		expect(() => hostScript(chunk, EGRESS_RELAY)).toThrow(
			/compiled install has no script files/,
		);
	});

	test("an mfw that no longer matches the manifest is refused", () => {
		writeFileSync(mfw, "#!/bin/sh\necho changed\n");
		expect(() =>
			hostCommand(hostEntry(chunk, AGENT_LAUNCHER), "/bin/bun", chunk),
		).toThrow(/does not match the hash in the install manifest/);
	});

	test("an mfw replaced after it was verified is hashed again", () => {
		const ref = hostEntry(chunk, AGENT_LAUNCHER);
		expect(hostCommand(ref, "/bin/bun", chunk)[0]).toBe(mfw);
		rmSync(mfw);
		writeFileSync(mfw, "#!/bin/sh\nexit 1\n");
		expect(() => hostCommand(ref, "/bin/bun", chunk)).toThrow(
			/does not match the hash/,
		);
	});

	test("an mfw that is a symlink is refused", () => {
		const real = join(root, "real-mfw");
		writeFileSync(real, "#!/bin/sh\nexit 0\n");
		rmSync(mfw);
		symlinkSync(real, mfw);
		expect(() =>
			hostCommand(hostEntry(chunk, AGENT_LAUNCHER), "/bin/bun", chunk),
		).toThrow(/not a regular file/);
	});

	test("an env override is refused, as from a plain bundle", () => {
		process.env.MFW_TEST_OVERRIDE_SCRIPT = mfw;
		try {
			expect(() =>
				resolveScript(chunk, CLAUDE_BRIDGE, "MFW_TEST_OVERRIDE_SCRIPT"),
			).toThrow(/refusing MFW_TEST_OVERRIDE_SCRIPT/);
		} finally {
			delete process.env.MFW_TEST_OVERRIDE_SCRIPT;
		}
		expect(
			isHostEntryRef(resolveScript(chunk, CLAUDE_BRIDGE, "MFW_UNSET_X")),
		).toBe(true);
	});

	test("removing the manifest does not bring script files back: the plain bundle has none", () => {
		rmSync(join(output, INSTALL_MANIFEST));
		expect(runsHostEntries(chunk)).toBe(false);
		expect(() => hostEntry(chunk, AGENT_LAUNCHER)).toThrow(
			/no host script manifest/,
		);
	});

	test("a malformed manifest is an error, never a plain bundle", () => {
		writeFileSync(join(output, INSTALL_MANIFEST), "{");
		expect(() => runsHostEntries(chunk)).toThrow(/unreadable/);
		writeManifest({ ...manifest, kind: "bundle" as never });
		expect(() => runsHostEntries(chunk)).toThrow(/wrong format/);
	});

	test("a manifest cannot point outside the install", () => {
		const libDir = output;
		expect(() =>
			installPath(libDir, {
				path: "../../../../outside/mfw",
				sha256: "0".repeat(64),
			}),
		).toThrow(/outside the install/);
		writeManifest({
			...manifest,
			mfw: { path: "/usr/bin/mfw", sha256: manifest.mfw.sha256 },
		});
		expect(() => readInstallManifest(libDir)).toThrow(/wrong format/);
	});

	test("checkInstall reports each part that does not verify", () => {
		expect(checkInstall(output).problems).toEqual([]);
		writeFileSync(join(output, "server/index.mjs"), "// changed\n");
		expect(checkInstall(output).problems).toEqual([
			"server: the bundle does not match the install manifest",
		]);
		writeManifest({ ...manifest, server: { digest: treeDigest(output) } });
		expect(checkInstall(output, { server: "f".repeat(64) }).problems).toEqual([
			"server: the bundle is not the one this mfw was built with",
		]);
		expect(checkInstall(output, { runtime: "e".repeat(64) }).problems).toEqual([
			"runtime: the manifest names another bun than this mfw was built with",
		]);
		expect(
			checkInstall(output, { self: join(root, "elsewhere/mfw") }).problems[0],
		).toContain("is not the install's mfw");
	});
});

describe("treeDigest", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mfw-tree-digest-"));
		for (const rel of ["server/a.mjs", "server/chunks/b.mjs", "public/c.css"]) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), rel);
		}
		writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), "n");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("changes with content, names, added files and links", () => {
		const base = treeDigest(root);
		expect(treeDigest(root)).toBe(base);
		writeFileSync(join(root, "server/a.mjs"), "changed");
		const changed = treeDigest(root);
		expect(changed).not.toBe(base);
		writeFileSync(join(root, "server/host-scripts.js"), "x");
		expect(treeDigest(root)).not.toBe(changed);
		const added = treeDigest(root);
		symlinkSync("../server/a.mjs", join(root, "public/link"));
		expect(treeDigest(root)).not.toBe(added);
	});

	test("refuses a link that leaves the tree: it would load code from elsewhere", () => {
		symlinkSync("/etc/passwd", join(root, "public/absolute"));
		expect(() => treeDigest(root)).toThrow(/links outside the install/);
		rmSync(join(root, "public/absolute"));
		symlinkSync("../../outside", join(root, "public/escape"));
		expect(() => treeDigest(root)).toThrow(/links outside the install/);
	});
});
