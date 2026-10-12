import { describe, expect, test } from "bun:test";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

/** The acceptance checklist procedure the task page and MCP `criteria` tool call. */

/** Errors are mapped by name (board-core's class, without depending on it here). */
class RuleViolationError extends Error {
	override name = "RuleViolationError";
}

function callerWith(editCriteria: (...args: unknown[]) => Promise<unknown>) {
	const svc = {
		name: "demo",
		tasks: { editCriteria },
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("tasks.criteria", () => {
	test("forwards one checklist op with baseRev, as an api edit", async () => {
		const calls: unknown[][] = [];
		const caller = callerWith(async (...args) => {
			calls.push(args);
			return { task: { id: "MFW-1" } as never, itemId: "c2" };
		});
		const out = await caller.tasks.criteria({
			project: "demo",
			id: "MFW-1",
			baseRev: 4,
			op: { op: "set", selector: "c2", checked: true },
		});
		expect(out).toMatchObject({ task: { id: "MFW-1" }, itemId: "c2" });
		expect(calls).toEqual([
			[
				"MFW-1",
				{ op: "set", selector: "c2", checked: true },
				{ baseRev: 4, source: "api" },
			],
		]);
	});

	test("a board rule refusing the write is PRECONDITION_FAILED naming the rule", async () => {
		const caller = callerWith(async () => {
			throw new RuleViolationError(
				"task MFW-1: refused by rule no-mutation-names:\n  no-mutation-names: acceptance c3: matches /mutat/",
			);
		});
		await expect(
			caller.tasks.criteria({
				project: "demo",
				id: "MFW-1",
				op: { op: "add", text: "mutation test passes" },
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringContaining("no-mutation-names"),
		});
	});
});
