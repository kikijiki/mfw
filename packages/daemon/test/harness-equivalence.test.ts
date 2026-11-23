import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_HARNESS_MANIFESTS } from "@mfw/plugin-api/harness-builtins";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
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

interface Golden extends Record<string, unknown> {
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
	for (const key of Object.keys(golden))
		test(key, () => {
			expect(live[key]).toEqual(golden[key]);
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
