import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildKind, isCompiledModuleUrl } from "@mfw/core/build-info";
import {
	BUILT_HOST_SCRIPTS,
	HOST_CONTENT_IDS,
	HOST_ENTRY_IDS,
	HOST_SUBCOMMAND,
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

const PROBE = join(import.meta.dir, "support/compiled-install-probe.ts");
const FAKE_MFW = "#!/bin/sh\nexit 0\n";

/** The probe, bundled once with the stamp a production bundle carries. */
let probeBundle: string;
let probeCache: string;
beforeAll(() => {
	probeCache = mkdtempSync(join(tmpdir(), "mfw-compiled-probe-"));
	probeBundle = join(probeCache, "probe.mjs");
	const stamp = JSON.stringify({
		kind: "bundle",
		version: "0.0.0",
		gitSha: "unknown",
		buildTime: "1970-01-01T00:00:00.000Z",
		bunVersion: Bun.version,
	});
	// In its own process: Bun.build is unreliable inside the test runner.
	const built = Bun.spawnSync(
		[
			process.execPath,
			"build",
			PROBE,
			"--target",
			"bun",
			"--outfile",
			probeBundle,
			"--define",
			`__MFW_BUILD__=${stamp}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(built.stderr.toString());
}, 60_000);
afterAll(() => rmSync(probeCache, { recursive: true, force: true }));

/**
 * A compiled install as `tools/install-build.ts` lays it out, whose server
 * bundle is the stamped probe: `<prefix>/bin/mfw` and
 * `<prefix>/lib/mfw/{install.json,server,public}`.
 */
describe("a compiled install's server runs host code only through mfw __host", () => {
	let root: string;
	let prefix: string;
	let libDir: string;
	let mfw: string;
	let chunk: string;
	let manifest: InstallManifest;

	const writeManifest = (m: InstallManifest) =>
		writeFileSync(join(libDir, INSTALL_MANIFEST), JSON.stringify(m));
	const probe = (
		op: string,
		name = "AGENT_LAUNCHER",
		env: Record<string, string> = {},
		at = chunk,
	): { ok: boolean; value?: unknown; error?: string } => {
		const r = Bun.spawnSync([process.execPath, at, op, name], {
			env: { PATH: process.env.PATH ?? "", ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		return JSON.parse(
			r.stdout.toString() ||
				`{"ok":false,"error":${JSON.stringify(r.stderr.toString())}}`,
		);
	};

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-compiled-install-")));
		prefix = join(root, "opt/mfw");
		libDir = join(prefix, "lib/mfw");
		mkdirSync(join(libDir, "server/chunks/_"), { recursive: true });
		mkdirSync(join(libDir, "public"));
		mkdirSync(join(prefix, "bin"));
		writeFileSync(join(libDir, "THIRD_PARTY_NOTICES.txt"), "notices\n");
		writeFileSync(join(libDir, "server/index.mjs"), "// server\n");
		chunk = join(libDir, "server/chunks/_/probe.mjs");
		copyFileSync(probeBundle, chunk);
		mfw = join(prefix, "bin/mfw");
		writeFileSync(mfw, FAKE_MFW);
		chmodSync(mfw, 0o755);
		const fake = { path: "../../bin/mfw", sha256: sha256Hex(FAKE_MFW) };
		manifest = {
			version: INSTALL_MANIFEST_VERSION,
			kind: "compiled",
			mfw: fake,
			mfwBoard: fake,
			runtime: { ...fake, bunVersion: "1.3.13" },
			server: { digest: treeDigest(libDir) },
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
		expect(probe("runs")).toEqual({ ok: true, value: true });
		expect(probe("command", "APP_SERVER_DRIVER").value).toEqual([
			mfw,
			HOST_SUBCOMMAND,
			"app-server-driver",
		]);
		expect(probe("argv", "CLAUDE_BRIDGE").value).toEqual([
			mfw,
			HOST_SUBCOMMAND,
			"claude-bridge",
		]);
	});

	test("a script path is refused: the install has no script files to load", () => {
		mkdirSync(join(libDir, "server/host-scripts"));
		writeFileSync(join(libDir, "server/host-scripts/manifest.json"), "{}");
		for (const name of ["AGENT_LAUNCHER", "EGRESS_RELAY"]) {
			expect(probe("script", name).error).toMatch(
				/compiled install has no script files/,
			);
		}
	});

	test("an mfw that no longer matches the manifest is refused, at every use", () => {
		expect(probe("command").ok).toBe(true);
		writeFileSync(mfw, "#!/bin/sh\necho changed\n");
		expect(probe("command").error).toMatch(
			/does not match the hash in the install manifest/,
		);
	});

	test("an mfw that is a symlink is refused", () => {
		const real = join(root, "real-mfw");
		writeFileSync(real, FAKE_MFW);
		rmSync(mfw);
		symlinkSync(real, mfw);
		expect(probe("command").error).toMatch(/not a regular file/);
	});

	test("an env override is refused, as from a plain bundle", () => {
		expect(
			probe("resolve", "CLAUDE_BRIDGE", { MFW_TEST_OVERRIDE_SCRIPT: mfw })
				.error,
		).toMatch(/refusing MFW_TEST_OVERRIDE_SCRIPT/);
		expect(String(probe("resolve", "CLAUDE_BRIDGE").value)).toStartWith(
			"mfw-host:",
		);
	});

	test("removing the manifest does not bring script files back: the plain bundle has none", () => {
		rmSync(join(libDir, INSTALL_MANIFEST));
		expect(probe("runs").value).toBe(false);
		expect(probe("command").error).toMatch(/no host script manifest/);
	});

	test("a malformed manifest is an error, never a plain bundle", () => {
		writeFileSync(join(libDir, INSTALL_MANIFEST), "{");
		expect(probe("runs").error).toMatch(/unreadable/);
		writeManifest({ ...manifest, kind: "bundle" as never });
		expect(probe("runs").error).toMatch(/wrong format/);
	});

	// Security review REL-1 L6.
	test("a checkout's build ignores an install.json planted in its output", () => {
		const output = join(root, "repo/apps/start/.output");
		mkdirSync(join(output, "server/chunks/_"), { recursive: true });
		const legacy = join(output, "server/chunks/_/probe.mjs");
		copyFileSync(probeBundle, legacy);
		writeFileSync(join(output, INSTALL_MANIFEST), JSON.stringify(manifest));
		expect(probe("runs", "AGENT_LAUNCHER", {}, legacy).value).toBe(false);
		expect(probe("command", "AGENT_LAUNCHER", {}, legacy).error).toMatch(
			/no host script manifest/,
		);
	});

	test("a manifest cannot point outside the install", () => {
		expect(() =>
			installPath(libDir, {
				path: "../../../outside/mfw",
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
		expect(checkInstall(libDir).problems).toEqual([]);
		writeFileSync(join(libDir, "server/index.mjs"), "// changed\n");
		expect(checkInstall(libDir).problems).toEqual([
			"server: the bundle does not match the install manifest",
		]);
		writeManifest({ ...manifest, server: { digest: treeDigest(libDir) } });
		expect(checkInstall(libDir, { server: "f".repeat(64) }).problems).toEqual([
			"server: the bundle is not the one this mfw was built with",
		]);
		expect(checkInstall(libDir, { runtime: "e".repeat(64) }).problems).toEqual([
			"runtime: the manifest names another bun than this mfw was built with",
		]);
		expect(
			checkInstall(libDir, { self: join(root, "elsewhere/mfw") }).problems[0],
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

describe("the launcher's toolchain root", () => {
	test("from source it is the bun running this code", async () => {
		const { launcherRuntime } = await import(
			"../src/containment/probe-runtime.ts"
		);
		expect(launcherRuntime()).toBe(process.execPath);
	});
});
