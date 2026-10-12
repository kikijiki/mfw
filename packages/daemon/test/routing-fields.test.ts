import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { defaultBoardYaml } from "../src/default-board-config.ts";
import {
	addRoutingFields,
	upgradeRoutingFields,
} from "../src/tasks/routing-fields.ts";

/** The default board.yaml as a board created before the routing fields existed has it. */
function legacy(): string {
	const yaml = defaultBoardYaml("MFW").replace(
		/ {6}# Routing pins[^\n]*\n(?: {6}#[^\n]*\n)* {6}provider: [^\n]*\n {6}model: [^\n]*\n/,
		"",
	);
	expect(yaml).not.toContain("provider:");
	return yaml;
}

describe("routing fields board.yaml upgrade", () => {
	test("adds provider and model as inserted lines, keeps the rest, and is idempotent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-route-yaml-"));
		const path = join(dir, "board.yaml");
		const before = legacy();
		await writeFile(path, before);
		expect(await upgradeRoutingFields(path)).toBe(true);
		const after = await readFile(path, "utf8");
		const added = after
			.split("\n")
			.filter((l) => !before.split("\n").includes(l));
		expect(added).toEqual([
			"      provider: { optional: true, pattern: '[A-Za-z0-9_-]+' }",
			"      model: { optional: true }",
		]);
		const config = await loadBoardConfig(path);
		expect(config.types.task?.fields.provider?.kind).toBe("scalar");
		expect(config.types.task?.fields.model?.kind).toBe("scalar");
		expect(await upgradeRoutingFields(path)).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});

	test("a board that declares its own 'model' keeps it", () => {
		const text = legacy().replace(
			"      owns: { list: true, optional: true }\n",
			"      owns: { list: true, optional: true }\n      model: { list: true, optional: true }\n",
		);
		const out = addRoutingFields(text);
		expect(out).toContain("model: { list: true, optional: true }");
		expect(out.match(/\n {6}model:/g)?.length).toBe(1);
		expect(out).toContain("provider: { optional: true");
	});
});
