import { describe, expect, test } from "bun:test";
import {
	coerceFieldValue,
	coerceListElement,
	coerceScalar,
	documentToJson,
	matchesQueryFilters,
	parseQueryFilters,
} from "../src/cli-support.ts";
import type { FieldSpec } from "../src/config.ts";
import type { BoardDocument } from "../src/store.ts";

function doc(overrides: Partial<BoardDocument> = {}): BoardDocument {
	return {
		type: "task",
		id: "TK-1",
		rev: 1,
		fields: { status: "doing", depends_on: ["TK-2", "TK-3"] },
		body: "body text",
		path: "/tasks/TK-1.md",
		hash: "abc123",
		...overrides,
	};
}

describe("parseQueryFilters (R5)", () => {
	test("field=value parses as an eq filter with one value", () => {
		expect(parseQueryFilters(["status=doing"])).toEqual([
			{ field: "status", op: "eq", values: ["doing"] },
		]);
	});

	test("field=a|b parses as an eq filter with alternation", () => {
		expect(parseQueryFilters(["status=done|archived"])).toEqual([
			{ field: "status", op: "eq", values: ["done", "archived"] },
		]);
	});

	test("field~value parses as a has (list-membership) filter", () => {
		expect(parseQueryFilters(["depends_on~TK-2"])).toEqual([
			{ field: "depends_on", op: "has", values: ["TK-2"] },
		]);
	});

	test("a token with neither = nor ~ is rejected", () => {
		expect(() => parseQueryFilters(["not-a-filter"])).toThrow(/invalid filter/);
	});
});

describe("matchesQueryFilters (R5)", () => {
	test("eq matches the field's string value, including alternation", () => {
		expect(
			matchesQueryFilters(doc(), parseQueryFilters(["status=doing"])),
		).toBe(true);
		expect(
			matchesQueryFilters(doc(), parseQueryFilters(["status=done|doing"])),
		).toBe(true);
		expect(matchesQueryFilters(doc(), parseQueryFilters(["status=done"]))).toBe(
			false,
		);
	});

	test("eq on 'id' matches the document's own id, not a fields.id", () => {
		expect(matchesQueryFilters(doc(), parseQueryFilters(["id=TK-1"]))).toBe(
			true,
		);
	});

	test("has matches list membership, including alternation", () => {
		expect(
			matchesQueryFilters(doc(), parseQueryFilters(["depends_on~TK-2"])),
		).toBe(true);
		expect(
			matchesQueryFilters(doc(), parseQueryFilters(["depends_on~TK-9|TK-3"])),
		).toBe(true);
		expect(
			matchesQueryFilters(doc(), parseQueryFilters(["depends_on~TK-9"])),
		).toBe(false);
	});

	test("has against a non-list field never matches", () => {
		expect(
			matchesQueryFilters(doc(), parseQueryFilters(["status~doing"])),
		).toBe(false);
	});

	test("multiple filters AND together", () => {
		const filters = parseQueryFilters(["status=doing", "depends_on~TK-2"]);
		expect(matchesQueryFilters(doc(), filters)).toBe(true);
		expect(
			matchesQueryFilters(doc({ fields: { status: "done" } }), filters),
		).toBe(false);
	});
});

describe("documentToJson (R5)", () => {
	test("includes fields, body, path, rev, hash", () => {
		expect(documentToJson(doc())).toEqual({
			type: "task",
			id: "TK-1",
			rev: 1,
			fields: { status: "doing", depends_on: ["TK-2", "TK-3"] },
			body: "body text",
			path: "/tasks/TK-1.md",
			hash: "abc123",
		});
	});
});

describe("coerceScalar / coerceFieldValue strictness", () => {
	const boolSpec = { kind: "scalar", type: "boolean" } as unknown as FieldSpec;
	const numSpec = { kind: "scalar", type: "number" } as unknown as FieldSpec;
	const boolList = { ...boolSpec, list: true } as unknown as FieldSpec;
	const numList = { ...numSpec, list: true } as unknown as FieldSpec;

	test("booleans accept exactly true/false", () => {
		expect(coerceScalar("boolean", "true")).toBe(true);
		expect(coerceScalar("boolean", "false")).toBe(false);
		for (const bad of ["ture", "yes", "True", "", "1"]) {
			expect(() => coerceScalar("boolean", bad)).toThrow(
				`field must be true or false, got '${bad}'`,
			);
		}
	});

	test("numbers reject empty and non-numeric text", () => {
		expect(coerceScalar("number", "-1.5")).toBe(-1.5);
		for (const bad of ["", "  ", "abc", "1x", "NaN", "Infinity"]) {
			expect(() => coerceScalar("number", bad)).toThrow("must be a number");
		}
	});

	test("list elements go through the same checks", () => {
		expect(coerceFieldValue(boolList, "true,false")).toEqual([true, false]);
		expect(() => coerceFieldValue(boolList, "true,yes")).toThrow(
			"true or false",
		);
		expect(coerceFieldValue(numList, "1,2")).toEqual([1, 2]);
		expect(() => coerceFieldValue(numList, "1,,2")).toThrow("a number");
		expect(() => coerceListElement(boolSpec, "ture")).toThrow("true or false");
		expect(() => coerceFieldValue(numSpec, "x")).toThrow("a number");
	});
});

describe("json list fields take a JSON array", () => {
	const spec = {
		kind: "scalar",
		type: "json",
		list: true,
		optional: true,
	} as unknown as FieldSpec;

	test("a JSON array literal is parsed whole, commas inside elements intact", () => {
		expect(
			coerceFieldValue(
				spec,
				'[{"id":"a1","text":"x, y"},{"id":"a2","text":"z"}]',
			),
		).toEqual([
			{ id: "a1", text: "x, y" },
			{ id: "a2", text: "z" },
		]);
	});

	test("a non-array JSON value is rejected, the comma form is unchanged elsewhere", () => {
		expect(() => coerceFieldValue(spec, "[1,")).toThrow();
		const plain = {
			kind: "enum",
			values: ["a", "b"],
			list: true,
			optional: true,
		} as unknown as FieldSpec;
		expect(coerceFieldValue(plain, "a,b")).toEqual(["a", "b"]);
	});
});
