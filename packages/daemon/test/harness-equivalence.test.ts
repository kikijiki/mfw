import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ALL_TOOLS,
	installPath,
	TOOLS,
} from "@mfw/board/commands/skill-targets";
import { stripAutonomyFlags } from "@mfw/plugin-api/harness-autonomy";
import { BUILTIN_HARNESS_MANIFESTS } from "@mfw/plugin-api/harness-builtins";
import {
	builtinHarnessRegistry,
	FLEET_ENV_CEILING,
} from "@mfw/plugin-api/harness-registry";
import { CAPABILITIES } from "../src/agents/acp-translate.ts";
import { isHostExecutedPath } from "../src/brain-runtime/decision-rights.ts";
import { autonomyFlags } from "../src/containment/agent-profile.ts";
import { buildAllowlist } from "../src/containment/egress-policy.ts";
import {
	isAllowedEnvName,
	parseSandboxProfile,
} from "../src/containment/profile.ts";
import {
	BYPASS_CORPUS,
	NOT_BYPASS,
	WRAPPER_ARGV,
} from "./fixtures/autonomy-bypass-corpus.ts";
import { captureHarnessMaps } from "./fixtures/harness-maps-snapshot.ts";

interface CatalogueRow {
	id: string;
	name: string;
	description: string;
	bin: string;
	versionArgs: string[];
	docsUrl?: string;
	auth: unknown[];
	models: unknown[];
	defaultModel: string;
	modelsAreSnapshot: boolean;
	tiers?: unknown;
	acceptsEndpoints?: boolean;
}

interface AutonomyRow {
	argv: string[];
	flags: string[];
	without: string[];
}

interface Golden extends Record<string, unknown> {
	autonomyCorpus: AutonomyRow[];
	catalogue: CatalogueRow[];
	remote: Record<string, { binary: string; authPaths: string[] }>;
	configPaths: Record<string, string[]>;
	fleetWritable: Record<string, string[]>;
	brainTranscriptDir: Record<string, string>;
	egress: Record<
		string,
		{ entries: unknown[]; telemetryOffEnv: Record<string, string> }
	>;
}

const golden: Golden = JSON.parse(
	readFileSync(
		join(import.meta.dir, "fixtures/harness-legacy-maps.json"),
		"utf8",
	),
);
const registry = builtinHarnessRegistry();
const manifest = (id: string) => registry.require(id);

describe("the code produces what the hand-written maps produced", () => {
	const live = captureHarnessMaps();
	for (const key of Object.keys(golden).filter((k) => k !== "autonomyCorpus"))
		test(key, () => {
			expect(live[key]).toEqual(golden[key]);
		});

	/** The owner's decision after R4: spellings the old list missed. */
	const NOW_DETECTED = ["-y", "--force", "--approval-mode yolo"];
	const argvLine = (row: AutonomyRow) => row.argv.slice(1, -1).join(" ");

	test("autonomy: only the decided spellings changed", () => {
		const before = golden.autonomyCorpus;
		const after = live.autonomyCorpus as AutonomyRow[];
		expect(after.map(argvLine)).toEqual(before.map(argvLine));
		const changed = after.filter(
			(row, i) => JSON.stringify(row) !== JSON.stringify(before[i]),
		);
		expect(changed.map(argvLine)).toEqual(NOW_DETECTED);
		for (const row of changed) {
			expect(row.flags).toEqual([argvLine(row)]);
			expect(row.without).toEqual(["cli", "tail"]);
		}
	});

	test("the snapshot covers the same sections", () => {
		expect(Object.keys(live).sort()).toEqual(Object.keys(golden).sort());
	});
});

describe("each manifest holds the old map's value", () => {
	test("every catalogue entry has a manifest, in order", () => {
		expect(BUILTIN_HARNESS_MANIFESTS.map((m) => m.id)).toEqual(
			golden.catalogue.map((p) => p.id),
		);
	});

	for (const entry of golden.catalogue)
		test(`${entry.id}: detection, auth, models`, () => {
			const m = manifest(entry.id);
			expect(m.displayName).toBe(entry.name);
			expect(m.description).toBe(entry.description);
			expect(m.detect.bin).toBe(entry.bin);
			expect(m.detect.versionArgs).toEqual(entry.versionArgs);
			expect(m.docsUrl).toBe(entry.docsUrl);
			expect<unknown>(m.auth.methods).toEqual(entry.auth);
			expect<unknown>(m.models?.choices).toEqual(entry.models);
			expect(m.models?.default).toBe(entry.defaultModel);
			expect(m.models?.isSnapshot).toBe(entry.modelsAreSnapshot);
			expect<unknown>(m.models?.tiers).toEqual(entry.tiers);
			expect(m.acceptsEndpoints).toBe(entry.acceptsEndpoints === true);
		});

	for (const [id, remote] of Object.entries(golden.remote))
		test(`${id}: remote probe facts`, () => {
			const m = manifest(id);
			expect(m.detect.bin).toBe(remote.binary);
			expect(m.auth.remoteLoginFiles).toEqual(remote.authPaths);
		});

	for (const [id, paths] of Object.entries(golden.configPaths))
		test(`${id}: project config paths`, () => {
			expect(manifest(id).install.projectConfig).toEqual(paths);
		});

	for (const cli of ["claude", "codex"])
		test(`${cli}: fleet, egress and telemetry`, () => {
			const m = registry.byFleetCli(cli);
			expect(m.fleet.writable).toEqual(golden.fleetWritable[cli] as string[]);
			expect(m.fleet.transcriptDir).toBe(golden.brainTranscriptDir[cli]);
			expect(m.fleet.attestation).toBe("unattested-config");
			expect<unknown>(m.egress).toEqual(golden.egress[cli]?.entries);
			expect<unknown>(m.telemetryOff?.env).toEqual(
				golden.egress[cli]?.telemetryOffEnv,
			);
		});
});

describe("the manifests agree with the code they describe", () => {
	const bridgeCapabilities = (file: string) => {
		const source = readFileSync(
			join(import.meta.dir, "../src/agents/bridges", file),
			"utf8",
		);
		const block = source.match(/capabilities: \{\n([^}]*steer[^}]*)\}/)?.[1];
		if (!block) throw new Error(`no capability block in ${file}`);
		return Object.fromEntries(
			[...block.matchAll(/(\w+): (true|false)/g)].map((x) => [
				x[1],
				x[2] === "true",
			]),
		);
	};

	test.each([
		["claude-cli", "claude-app-server.ts"],
		["codex-cli", "codex-app-server-bridge.ts"],
	])("%s declares what its task bridge declares", (id, file) => {
		expect(manifest(id).capabilities).toMatchObject(bridgeCapabilities(file));
	});

	test("every ACP manifest declares what the ACP bridge declares", () => {
		for (const m of registry.list().filter((x) => x.dialect === "acp"))
			expect(m.capabilities).toMatchObject(CAPABILITIES);
	});

	test("the sandbox profile's fleet list is the manifests' list", () => {
		const fleet = registry.list().flatMap((m) => m.fleet.cli ?? []);
		expect(fleet.sort()).toEqual([...FLEET_ENV_CEILING.keys()].sort());
		for (const m of registry.list())
			if (m.fleet.cli)
				expect(m.fleet.env).toBe(FLEET_ENV_CEILING.get(m.fleet.cli) as string);
	});

	test("every project path and directory is host-executed", () => {
		for (const m of registry.list()) {
			for (const path of m.install.projectConfig)
				expect(isHostExecutedPath(path), `${m.id}: ${path}`).toBe(true);
			for (const dir of m.install.projectDirs)
				expect(isHostExecutedPath(`${dir}/any`), `${m.id}: ${dir}`).toBe(true);
		}
	});

	test.each([
		"agents/acp-translate.ts",
		"agents/agent-identity.ts",
	])("%s, which the ACP bridge bundles, stays free of the validator", (file) => {
		const source = readFileSync(join(import.meta.dir, "../src", file), "utf8");
		const runtime = [
			...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm),
		]
			.map((x) => x[1] as string)
			.filter((x) => x.includes("plugin-api") || x.startsWith("@mfw/"));
		expect(runtime).toEqual(["../../../plugin-api/src/harness-builtins.ts"]);
	});

	test("the built-in data the bridge reads is what the registry validated", () => {
		expect(
			BUILTIN_HARNESS_MANIFESTS.map((m) => [m.id, m.acp, m.detect.identity]),
		).toEqual(
			registry.list().map((m) => [m.id, m.acp, m.detect.identity]) as never,
		);
	});

	test("skill directories match what the board installs", () => {
		for (const tool of ALL_TOOLS) {
			const m = registry.list().find((x) => x.detect.bin === TOOLS[tool].exe);
			const installed = installPath(tool, "project", "/fixture", {});
			expect(installed).toBe(
				`/fixture/${m?.install.skills}/mfw-board/SKILL.md`,
			);
		}
	});
});

describe("a hostile manifest stops at the existing gates too", () => {
	const fleetConfig = (writable: string[]) => ({
		version: 1,
		role: "task",
		home: "synthetic",
		filesystem: {
			fleetConfig: { cli: "claude", source: "/fixture/fleet", writable },
		},
	});

	test.each([
		"..",
		"../..",
		".",
		"/",
		"a/../b",
		"-x",
		"sessions/",
	])("the sandbox profile refuses the fleet dir %s", (dir) => {
		expect(() => parseSandboxProfile(fleetConfig([dir]))).toThrow();
	});

	test("the sandbox profile refuses a fleet CLI it does not know", () => {
		const profile = fleetConfig(["sessions"]);
		profile.filesystem.fleetConfig.cli = "home";
		expect(() => parseSandboxProfile(profile)).toThrow();
	});

	test.each([
		"*.example.com",
		"*",
		"127.0.0.1",
		"169.254.169.254",
		"foo.123",
	])("the proxy's allowlist refuses the host %s", (host) => {
		expect(() => buildAllowlist([{ host, port: 443 }])).toThrow();
	});

	test.each([
		"LD_PRELOAD",
		"GIT_SSH_COMMAND",
		"GCONV_PATH",
		"PATH",
		"HOME",
	])("the sandbox env allowlist refuses %s", (name) => {
		expect(isAllowedEnvName(name)).toBe(false);
	});

	test.each([
		"--dangerously-skip-permissions",
		"--yolo",
		"--full-auto",
	])("the launch gate still sees %s", (flag) => {
		expect(autonomyFlags(["cli", flag])).toEqual([flag]);
	});
});

describe("the review's bypass cases against the frozen old detector", () => {
	const frozen: { rows: AutonomyRow[] } = JSON.parse(
		readFileSync(
			join(import.meta.dir, "fixtures/autonomy-bypass-frozen.json"),
			"utf8",
		),
	);
	const key = (argv: readonly string[]) => JSON.stringify(argv);
	const stillAsks = new Set(NOT_BYPASS.map((row) => key(["cli", ...row])));
	const bypasses = [
		...Object.values(BYPASS_CORPUS)
			.flat()
			.map((row) => ["cli", ...row]),
		...WRAPPER_ARGV,
	];

	test("the snapshot holds every corpus row", () => {
		expect(frozen.rows.map((r) => key(r.argv)).sort()).toEqual(
			[...bypasses.map(key), ...stillAsks].sort(),
		);
	});

	test("the old detector missed most of them, so the snapshot proves a change", () => {
		const missed = frozen.rows.filter(
			(r) => !stillAsks.has(key(r.argv)) && r.flags.length === 0,
		);
		expect(missed.length).toBeGreaterThan(50);
	});

	for (const row of frozen.rows)
		test(`${JSON.stringify(row.argv)}`, () => {
			const now = autonomyFlags(row.argv);
			if (stillAsks.has(key(row.argv))) {
				// Not a bypass then or now: nothing about it may change.
				expect(row.flags).toEqual([]);
				expect(now).toEqual([]);
				expect(
					stripAutonomyFlags(builtinHarnessRegistry().autonomy, row.argv),
				).toEqual(row.without);
			} else {
				expect(now.length).toBeGreaterThan(0);
			}
		});
});
