import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolationDispatchProblem } from "../src/config.ts";
import {
	devEnvRefusal,
	NO_DEV_ENV_RESOLVER,
} from "../src/containment/agent-preflight.ts";

describe("user-facing refusals name no internal work package", () => {
	test("the dev environment refusals", () => {
		expect(NO_DEV_ENV_RESOLVER).not.toContain("P8");
		const r = devEnvRefusal({
			kind: "refused",
			code: "env_not_approved",
			reason: "not approved",
			fix: "mfw env allow p",
			commit: null,
		});
		expect(r?.detail).not.toContain("P8");
		// Never steer the owner to an unsandboxed run (the 2026-11-22 incident).
		expect(`${r?.detail} ${NO_DEV_ENV_RESOLVER}`).not.toContain(
			"agentIsolation",
		);
		for (const runWorkspace of ["worktree", "clone"] as const) {
			const issue = isolationDispatchProblem({ runWorkspace });
			expect(`${issue?.detail} ${issue?.fix}`).not.toContain("P8");
		}
	});

	test("no string literal in the refusal sources mentions it", () => {
		for (const file of [
			"config.ts",
			"verifier.ts",
			"containment/agent-preflight.ts",
		]) {
			const code = readFileSync(join(import.meta.dir, "../src", file), "utf8")
				.split("\n")
				.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
				.join("\n");
			expect(code).not.toMatch(/\bP8\b/);
		}
	});

	test("a stale attestation does not claim the doctor re-probes", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/containment/attestation-gate.ts"),
			"utf8",
		);
		expect(source).not.toContain("(see `mfw doctor`)");
	});

	const fixSource = () =>
		readFileSync(join(import.meta.dir, "../src/refusal-fix.ts"), "utf8")
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join("\n");

	test("the remedies name no internal id", () => {
		expect(fixSource()).not.toMatch(
			/\b(P\d+[a-z]?|A\d+\.\d+|W\d+-\d+|B\d{1,2}|REL-\d+|WP-?\d+)\b/,
		);
	});

	test("an API procedure is presented as the API, not as a command or a page", () => {
		const source = fixSource();
		const calls = source.match(/.{0,12}hostResources\.\w+/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call).toContain("API");
	});
});
