import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type HarnessConformanceSubject,
	KNOWN_BYPASS_ARGV,
	runHarnessConformance,
} from "../src/conformance/harness.ts";
import { failures } from "../src/conformance/kit.ts";
import { KNOWN_AUTONOMY } from "../src/harness-autonomy.ts";
import { BUILTIN_HARNESS_MANIFESTS } from "../src/harness-builtins.ts";

/** A minimal detector; the daemon's suite runs its real one. */
const detect: HarnessConformanceSubject["detect"] = async (spec, env) => {
	const path = join(env.PATH, spec.bin);
	try {
		accessSync(path, constants.X_OK);
	} catch {
		return { installed: false, version: null };
	}
	const run = (args: readonly string[]) =>
		spawnSync(path, [...args], { encoding: "utf8" }).stdout ?? "";
	if (spec.identity?.kind === "symlink-target") {
		if (basename(realpathSync(path)) !== spec.identity.basename)
			return { installed: false, version: null };
	} else if (spec.identity?.kind === "help-text") {
		const re = new RegExp(spec.identity.pattern, spec.identity.flags);
		if (!re.test(run(spec.identity.args)))
			return { installed: false, version: null };
	}
	return { installed: true, version: run(spec.versionArgs).trim() };
};

const subject = (manifest: unknown): HarnessConformanceSubject => ({
	manifest,
	origin: "builtin",
	detect,
	helpText: "pi - AI coding assistant",
});

describe("harness conformance", () => {
	for (const manifest of BUILTIN_HARNESS_MANIFESTS)
		test(`${manifest.id} conforms`, async () => {
			const results = await runHarnessConformance(subject(manifest));
			expect(failures(results)).toEqual([]);
			expect(results.filter((r) => r.status === "skip")).toEqual([]);
			expect(results.length).toBeGreaterThanOrEqual(7);
		});

	test("the per-harness bypass lists add up to the core floor", () => {
		const listed = new Set(
			[...KNOWN_BYPASS_ARGV.values()].flatMap((rows) =>
				rows.filter((r) => r.length === 1).map((r) => r[0]),
			),
		);
		for (const flag of KNOWN_AUTONOMY.flags) expect(listed).toContain(flag);
	});

	const failing = async (patch: Record<string, unknown>) => {
		const base = BUILTIN_HARNESS_MANIFESTS.find((m) => m.id === "claude-cli");
		const results = await runHarnessConformance(
			subject({ ...structuredClone(base), ...patch }),
		);
		return failures(results).map((f) => f.name);
	};

	test("fails a manifest that drops a known bypass flag", async () => {
		const base = BUILTIN_HARNESS_MANIFESTS.find((m) => m.id === "claude-cli");
		expect(
			await failing({
				autonomy: {
					...base?.autonomy,
					flags: ["--dangerously-skip-permissions"],
				},
			}),
		).toContain("the autonomy list covers the known bypass flags");
	});

	test("fails a wildcard host at the schema", async () => {
		expect(
			await failing({
				egress: [{ host: "*.example.com", port: 443, purpose: "other" }],
			}),
		).toEqual(["the manifest passes the schema"]);
	});

	test("fails a writable dir over the ceiling", async () => {
		const names = await failing({
			fleet: {
				cli: "claude",
				env: "CLAUDE_CONFIG_DIR",
				writable: ["plugins"],
				attestation: "unattested-config",
			},
		});
		expect(names).toContain("the manifest is within the ceilings");
		expect(names).toContain("fleet dirs are within the ceiling and marked");
	});

	test("fails a detector that accepts an impostor", async () => {
		const pi = BUILTIN_HARNESS_MANIFESTS.find((m) => m.id === "pi");
		const results = await runHarnessConformance({
			...subject(pi),
			detect: async (spec, env) => {
				try {
					accessSync(join(env.PATH, spec.bin), constants.X_OK);
					return { installed: true, version: "9.8.7-conformance" };
				} catch {
					return { installed: false, version: null };
				}
			},
		});
		expect(failures(results).map((f) => f.name)).toEqual([
			"detect refuses an impostor with the same name",
		]);
	});
});
