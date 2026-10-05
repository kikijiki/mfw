import { describe, expect, test } from "bun:test";
import {
	blockingDeps,
	CycleError,
	findCycle,
	findDanglingDeps,
	type GraphNode,
	readySet,
	topoSort,
} from "../src/dag.ts";
import type { TaskStatus } from "../src/types.ts";

function n(id: string, status: TaskStatus, deps: string[] = []): GraphNode {
	return { id, status, depends_on: deps };
}

describe("dag", () => {
	test("topoSort orders dependencies before dependents", () => {
		const nodes = [
			n("c", "ready", ["b"]),
			n("a", "ready"),
			n("b", "ready", ["a"]),
		];
		expect(topoSort(nodes)).toEqual(["a", "b", "c"]);
	});

	test("findCycle detects a cycle", () => {
		const nodes = [n("a", "ready", ["b"]), n("b", "ready", ["a"])];
		const cyc = findCycle(nodes);
		expect(cyc).not.toBeNull();
		expect(cyc as string[]).toContain("a");
		expect(cyc as string[]).toContain("b");
	});

	test("topoSort throws CycleError on a cyclic graph", () => {
		const nodes = [n("a", "ready", ["b"]), n("b", "ready", ["a"])];
		expect(() => topoSort(nodes)).toThrow(CycleError);
	});

	test("findDanglingDeps flags unknown dependency ids", () => {
		const nodes = [n("a", "ready", ["ghost"])];
		expect(findDanglingDeps(nodes)).toEqual([{ id: "a", missing: "ghost" }]);
	});

	test("readySet = ready tasks with all deps done", () => {
		const nodes = [
			n("a", "done"),
			n("b", "ready", ["a"]), // ready: dep done
			n("c", "ready", ["b"]), // not ready: dep b not done
			n("d", "backlog"), // not ready: wrong status
		];
		expect(readySet(nodes).map((x) => x.id)).toEqual(["b"]);
	});

	test("blockingDeps lists deps that aren't done", () => {
		const nodes = [
			n("a", "done"),
			n("b", "in_progress"),
			n("c", "ready", ["a", "b"]),
		];
		const node = nodes[2];
		expect(node).toBeDefined();
		if (!node) throw new Error("unreachable");
		expect(blockingDeps(node, nodes)).toEqual(["b"]);
	});
});
