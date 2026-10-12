import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { defaultBoardYaml } from "../src/default-board-config.ts";
import { upgradeProvenanceFields } from "../src/tasks/provenance-fields.ts";

/** The default board.yaml as a board created before the provenance fields existed has it. */
function legacy(): string {
	const yaml = defaultBoardYaml("MFW").replace(
		/ {6}# Provenance[^\n]*\n(?: {6}#[^\n]*\n)* {6}created_by: [^\n]*\n {6}edited_by: [^\n]*\n {6}superseded_by: [^\n]*\n/,
		"",
	);
	expect(yaml).not.toContain("created_by");
	return yaml;
}

describe("provenance fields board.yaml upgrade", () => {
	test("adds created_by, edited_by and superseded_by as inserted lines, and is idempotent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-prov-yaml-"));
		const path = join(dir, "board.yaml");
		const before = legacy();
		await writeFile(path, before);
		expect(await upgradeProvenanceFields(path)).toBe(true);
		const after = await readFile(path, "utf8");
		const added = after
			.split("\n")
			.filter((l) => !before.split("\n").includes(l));
		expect(added).toEqual([
			"      created_by: { optional: true }",
			"      edited_by: { optional: true }",
			"      superseded_by: { optional: true }",
		]);
		const config = await loadBoardConfig(path);
		expect(config.types.task?.fields.created_by?.kind).toBe("scalar");
		expect(await upgradeProvenanceFields(path)).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});
});
