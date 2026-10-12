import { describe, expect, test } from "bun:test";
import { BOARD_TEMPLATES } from "@mfw/daemon/board-templates";
import type { Orchestrator } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

describe("the board template catalogue", () => {
	test("lists every template for the picker without the yaml function", async () => {
		const api = createCaller({
			orchestrator: undefined as unknown as Orchestrator,
		});

		const result = await api.system.boardTemplates();

		expect(result.map((entry) => entry.id)).toEqual([
			"mfw-default",
			"kanban",
			"planning",
			"jira-like",
		]);
		expect(result).toEqual(
			BOARD_TEMPLATES.map(({ id, title, description, statuses }) => ({
				id,
				title,
				description,
				statuses,
			})),
		);
		for (const entry of result) {
			expect(Object.keys(entry).sort()).toEqual([
				"description",
				"id",
				"statuses",
				"title",
			]);
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.statuses.length).toBeGreaterThan(0);
		}
	});
});
