import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolationDispatchProblem } from "../src/config.ts";
import { DEV_SHELL_REFUSAL } from "../src/containment/agent-preflight.ts";

describe("user-facing refusals name no internal work package", () => {
	test("the dev-shell refusals", () => {
		expect(DEV_SHELL_REFUSAL).not.toContain("P8");
		for (const runWorkspace of ["worktree", "clone"] as const) {
			const issue = isolationDispatchProblem({
				runWorkspace,
				hasDevShell: true,
			});
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
});
