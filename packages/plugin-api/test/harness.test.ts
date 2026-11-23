import { describe, expect, test } from "bun:test";
import {
	HarnessManifestSchema,
	harnessWidenings,
	isAllowedEnvKey,
	isEgressHost,
	isSafeRelativePath,
} from "../src/harness.ts";

const base = () => ({
	schemaVersion: 1,
	manifestVersion: 1,
	displayName: "Codex",
	description: "A manifest for these tests.",
	resume: { method: "thread-arg", detail: "exec resume <thread>" },
	sandbox: { needsUserns: false, executables: ["codex"] },
	autonomy: {
		flags: [],
		values: [],
		config: [],
		configOptions: [],
		launchFlags: [],
	},
	install: { projectConfig: [], projectDirs: [] },
	id: "codex-cli",
	detect: {
		bin: "codex",
		versionArgs: ["--version"],
		versionRange: ">=0.170 <1",
	},
	dialect: "codex-app-server",
	modes: { task: ["app-server", "--model", "{model}"] },
	readOnly: { mechanism: "argv", value: ["--sandbox", "read-only"] },
	capabilities: { steer: true, interrupt: true, resume: true, mcp: true },
	completion: { signal: "turn.completed" },
	innerSandbox: {
		disableArgv: ["--dangerously-bypass-approvals-and-sandbox"],
	},
	fleet: {
		env: "CODEX_HOME",
		writable: ["sessions/", "cache/"],
		readOnly: ["config.toml", "skills/"],
	},
	egress: [{ host: "chatgpt.com", port: 443, purpose: "inference" }],
	env: {},
	auth: { kinds: ["subscription", "api-key"], loginHint: "codex login" },
});

describe("harness manifest", () => {
	test("accepts a complete manifest and fills defaults", () => {
		const m = HarnessManifestSchema.parse(base());
		expect(m.dialect).toBe("codex-app-server");
		expect(m.env).toEqual({});
	});

	test("is strict: unknown keys are rejected at every level", () => {
		expect(
			HarnessManifestSchema.safeParse({ ...base(), extra: 1 }).success,
		).toBe(false);
		const m = base();
		expect(
			HarnessManifestSchema.safeParse({
				...m,
				fleet: { ...m.fleet, mount: "/etc" },
			}).success,
		).toBe(false);
	});

	test("rejects an unknown dialect", () => {
		expect(
			HarnessManifestSchema.safeParse({ ...base(), dialect: "mine" }).success,
		).toBe(false);
	});

	test("detect.bin is a bare name, never a path", () => {
		for (const bin of ["/usr/bin/codex", "./codex", "../codex", "a b", ""]) {
			const m = base();
			expect(
				HarnessManifestSchema.safeParse({ ...m, detect: { ...m.detect, bin } })
					.success,
			).toBe(false);
		}
	});

	test("argv placeholders are a closed set", () => {
		const m = base();
		const withTask = (task: string[]) =>
			HarnessManifestSchema.safeParse({ ...m, modes: { task } }).success;
		expect(withTask(["--model", "{model}", "{effort}"])).toBe(true);
		expect(withTask(["{home}"])).toBe(false);
		expect(withTask(["{model"])).toBe(false);
		expect(withTask(["$(whoami)", "{{model}}"])).toBe(false);
	});

	test.each([
		["LD_PRELOAD", false],
		["LD_LIBRARY_PATH", false],
		["DYLD_INSERT_LIBRARIES", false],
		["PATH", false],
		["HOME", false],
		["NODE_OPTIONS", false],
		["BUN_CONFIG_REGISTRY", false],
		["HTTPS_PROXY", false],
		["https_proxy", false],
		["ALL_PROXY", false],
		["NODE_USE_ENV_PROXY", false],
		["lowercase", false],
		["1BAD", false],
		["CODEX_HOME", true],
		["ANTHROPIC_LOG", true],
	])("env key %s allowed=%p", (key, ok) => {
		expect(isAllowedEnvKey(key)).toBe(ok);
	});

	test("env values cannot smuggle NUL", () => {
		expect(
			HarnessManifestSchema.safeParse({ ...base(), env: { FOO: "a\0b" } })
				.success,
		).toBe(false);
		expect(
			HarnessManifestSchema.safeParse({ ...base(), env: { LD_PRELOAD: "x" } })
				.success,
		).toBe(false);
	});

	test.each([
		["sessions/", true],
		["config.toml", true],
		["a/b/c", true],
		["../escape", false],
		["a/../b", false],
		["/abs", false],
		["~/x", false],
		["a//b", false],
		["./a", false],
		["a\\b", false],
		["", false],
		["a\0b", false],
	])("fleet path %p safe=%p", (path, ok) => {
		expect(isSafeRelativePath(path)).toBe(ok);
	});

	test("egress hosts are exact names", () => {
		expect(isEgressHost("chatgpt.com")).toBe(true);
		expect(isEgressHost("api.anthropic.com")).toBe(true);
		for (const h of [
			"*.example.com",
			"127.0.0.1",
			"10.0.0.1",
			"localhost",
			"a_b.com",
			"",
		])
			expect(isEgressHost(h)).toBe(false);
	});

	test("widenings list egress, fleet writes, env and inner-sandbox changes", () => {
		const m = HarnessManifestSchema.parse({
			...base(),
			env: { CODEX_QUIET: "1" },
		});
		const kinds = harnessWidenings(m).map((w) => w.kind);
		expect(kinds).toContain("egress");
		expect(kinds).toContain("fleet-writable");
		expect(kinds).toContain("fleet-readonly");
		expect(kinds).toContain("env");
		expect(kinds).toContain("inner-sandbox");
		expect(harnessWidenings(m).find((w) => w.kind === "egress")?.detail).toBe(
			"chatgpt.com:443 (inference)",
		);
	});
});
