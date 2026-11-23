import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	HARNESS_MATRIX_PATH,
	renderHarnessMatrix,
} from "../src/harness-matrix.ts";
import { builtinHarnessRegistry } from "../src/harness-registry.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("the generated harness matrix", () => {
	test("the committed document is current (fix: bun run harness:matrix)", () => {
		const committed = readFileSync(join(repoRoot, HARNESS_MATRIX_PATH), "utf8");
		expect(committed).toBe(
			renderHarnessMatrix(builtinHarnessRegistry().list()),
		);
	});

	test("a changed manifest changes the document", () => {
		const list = builtinHarnessRegistry().list();
		const changed = list.map((m) =>
			m.id === "pi"
				? { ...m, capabilities: { ...m.capabilities, steer: true } }
				: m,
		);
		expect(renderHarnessMatrix(changed)).not.toBe(renderHarnessMatrix(list));
	});

	test("names every harness and marks the temporary fleet lists", () => {
		const text = renderHarnessMatrix(builtinHarnessRegistry().list());
		for (const m of builtinHarnessRegistry().list())
			expect(text).toContain(m.displayName);
		expect(text).toContain("`unattested-config`");
	});
});
