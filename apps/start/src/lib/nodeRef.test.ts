import { describe, expect, test } from "bun:test";

import {
	describeNodeRef,
	formatNodeRef,
	isNodeRef,
	NODE_KINDS,
	nodeRef,
	type ParsedNodeRef,
	parseNodeRef,
	taskIdOf,
} from "./nodeRef";

const SAMPLES: ParsedNodeRef[] = [
	{ kind: "brain" },
	{ kind: "task", id: "MFW-41" },
	{ kind: "group", id: "01JABCDEF" },
	{ kind: "run", id: "01JQ2ZZZZ" },
	{ kind: "turn", id: "01JTURN" },
	{ kind: "sub", runId: "01JQ2", callId: "toolu_01abc" },
	{ kind: "decision", id: 512 },
	{ kind: "merge", id: 7 },
];

describe("round trip", () => {
	test("every ref kind has a sample", () => {
		expect(SAMPLES.map((s) => s.kind).sort()).toEqual([...NODE_KINDS].sort());
	});

	test("parse(format(x)) is x for every kind", () => {
		for (const sample of SAMPLES) {
			expect(parseNodeRef(formatNodeRef(sample))).toEqual(sample);
		}
	});

	test("format(parse(s)) is s for the documented spellings", () => {
		for (const s of [
			"brain",
			"task:MFW-41",
			"run:01J0",
			"sub:01J0/toolu_x",
			"decision:123",
			"merge:9",
			"turn:01JT",
			"group:g1",
		]) {
			const parsed = parseNodeRef(s);
			expect(parsed).not.toBeNull();
			if (parsed) expect(formatNodeRef(parsed)).toBe(s);
		}
	});

	test("builders agree with the parser", () => {
		expect(parseNodeRef(nodeRef.task("A-1"))).toEqual({
			kind: "task",
			id: "A-1",
		});
		expect(parseNodeRef(nodeRef.sub("r", "c"))).toEqual({
			kind: "sub",
			runId: "r",
			callId: "c",
		});
		expect(parseNodeRef(nodeRef.decision(4))).toEqual({
			kind: "decision",
			id: 4,
		});
		expect(nodeRef.brain()).toBe("brain");
	});

	test("a task id may carry a colon or a slash and survives", () => {
		expect(parseNodeRef("task:a:b/c")).toEqual({ kind: "task", id: "a:b/c" });
	});

	test("a subagent call id may contain a slash; the run id may not", () => {
		expect(parseNodeRef("sub:r1/call/with/slash")).toEqual({
			kind: "sub",
			runId: "r1",
			callId: "call/with/slash",
		});
	});
});

describe("invalid refs", () => {
	test.each([
		"",
		"task",
		"task:",
		":x",
		"nope:1",
		"brain:1",
		"Brain",
		"task: x",
		"task:a b",
		"run:a\nb",
		"sub:run",
		"sub:/call",
		"sub:run/",
		"decision:abc",
		"decision:-1",
		"decision:1.5",
		"decision:",
		"merge:99999999999999999999",
	])("rejects %p", (bad) => {
		expect(parseNodeRef(bad)).toBeNull();
		expect(isNodeRef(bad)).toBe(false);
	});

	test("non-strings are rejected", () => {
		expect(parseNodeRef(null)).toBeNull();
		expect(parseNodeRef(undefined)).toBeNull();
		expect(parseNodeRef(12)).toBeNull();
		expect(parseNodeRef({ kind: "brain" })).toBeNull();
	});

	test("an over-long id is rejected", () => {
		expect(parseNodeRef(`task:${"x".repeat(300)}`)).toBeNull();
	});
});

describe("helpers", () => {
	test("taskIdOf reads only task refs", () => {
		expect(taskIdOf("task:MFW-1")).toBe("MFW-1");
		expect(taskIdOf("run:01J")).toBeNull();
		expect(taskIdOf(undefined)).toBeNull();
	});

	test("describeNodeRef", () => {
		expect(describeNodeRef({ kind: "run", id: "01J" })).toBe("run 01J");
		expect(describeNodeRef({ kind: "brain" })).toBe("brain");
	});
});
