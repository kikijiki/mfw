import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarnessConformance } from "@mfw/plugin-api/conformance/harness";
import { failures } from "@mfw/plugin-api/conformance/kit";
import { BUILTIN_HARNESS_MANIFESTS } from "@mfw/plugin-api/harness-builtins";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import { PROVIDER_CATALOGUE } from "../src/agents/catalogue.ts";
import {
	detectInstalledHarnesses,
	harnessDetectionTargets,
	ProviderDetector,
} from "../src/agents/detect.ts";

/** Security review m2: the doctor's route to harness detection. */
describe("detection from the manifests", () => {
	test("targets the same binaries, args and identities as the catalogue", () => {
		const targets = harnessDetectionTargets();
		expect(targets.map((t) => t.id)).toEqual(
			PROVIDER_CATALOGUE.map((p) => p.id),
		);
		for (const [i, target] of targets.entries()) {
			const entry = PROVIDER_CATALOGUE[i];
			expect(target.bin).toBe(entry?.bin as string);
			expect(target.versionArgs).toEqual(entry?.versionArgs as string[]);
			expect(target.identity).toBe(entry?.identity);
		}
	});

	test("reports every harness as missing on an empty PATH", async () => {
		const empty = mkdtempSync(join(tmpdir(), "mfw-harness-detect-"));
		try {
			const found = await detectInstalledHarnesses(
				new ProviderDetector({ env: { PATH: empty } }),
			);
			expect([...found.keys()]).toEqual(
				builtinHarnessRegistry()
					.detectionSpecs()
					.map((s) => s.id),
			);
			for (const d of found.values()) expect(d.installed).toBe(false);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	for (const manifest of BUILTIN_HARNESS_MANIFESTS)
		test(`${manifest.id} conforms with the real detector`, async () => {
			const results = await runHarnessConformance({
				manifest,
				origin: "builtin",
				helpText: "pi - AI coding assistant",
				detect: async (spec, env) => {
					const [target] = harnessDetectionTargets([spec]);
					if (!target) throw new Error("no detection target");
					const d = await new ProviderDetector({ env }).detect(target);
					return { installed: d.installed, version: d.version };
				},
			});
			expect(failures(results)).toEqual([]);
			expect(results.filter((r) => r.status === "skip")).toEqual([]);
		});
});
