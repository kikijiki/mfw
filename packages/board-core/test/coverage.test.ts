import { describe, expect, test } from "bun:test";
import { CoverageTableError, evaluateCoverage } from "../src/coverage.ts";
import type { CoverageRule } from "../src/external-config.ts";

const RULE: CoverageRule = {
	id: "ledger",
	source: "ledger.tsv",
	idColumn: "id",
	openWhen: { column: "resolution", equals: "open" },
	aliasColumn: "merged",
	aliasNone: "-",
	waivers: { file: "waive.tsv", idColumn: "id" },
	closedBy: {
		type: "task",
		field: "closes",
		exactly: 1,
		status: ["todo", "done"],
	},
	referencedBy: { type: "task", field: "contributes" },
	severity: "error",
};

const LEDGER = [
	"id\tseverity\tmerged\tresolution",
	"R1\tS1\tR2,R3\topen",
	"R4\tS2\t-\topen",
	"R5\tS2\t-\topen",
	"R6\tS3\t-\tfixed",
	"R7\tS3\t-\topen",
].join("\n");

const doc = (id: string, fields: Record<string, unknown>, status = "todo") => ({
	type: "task",
	id,
	status,
	fields,
	path: `${id}.md`,
});

describe("evaluateCoverage", () => {
	test("exactly one closer; aliases resolve to the merged row; waivers excuse", () => {
		const r = evaluateCoverage(RULE, LEDGER, "id\treason\nR5\tdeferred\n", [
			doc("T-1", { closes: ["R2"] }), // R2 was merged into R1
			doc("T-2", { closes: ["R4", "R7"] }),
		]);
		expect(r.findings).toEqual([]);
		expect(r).toMatchObject({ rows: 5, open: 4, waived: 1, covered: 3 });
	});

	test("zero and two closers are both reported, naming the closers", () => {
		const r = evaluateCoverage(RULE, LEDGER, "id\treason\n", [
			doc("T-1", { closes: ["R1", "R4"] }),
			doc("T-2", { closes: ["R4", "R3"] }), // R3 -> R1 as well
		]);
		const msgs = r.findings.map(
			(f) => `${f.kind} ${f.id}: ${f.closers?.join(",")}`,
		);
		expect(msgs).toContain("uncovered R1: T-1,T-2");
		expect(msgs).toContain("uncovered R4: T-1,T-2");
		expect(msgs).toContain("uncovered R5: ");
		expect(msgs).toContain("uncovered R7: ");
		expect(r.findings.find((f) => f.id === "R5")?.line).toBe(4);
	});

	test("a closer whose status does not count is not a closer; its unknown ids still report", () => {
		const r = evaluateCoverage(RULE, LEDGER, "id\treason\n", [
			doc("T-1", { closes: ["R1"] }, "dropped"),
			doc("T-2", { closes: ["R999"] }, "dropped"),
		]);
		expect(
			r.findings.some((f) => f.kind === "uncovered" && f.id === "R1"),
		).toBe(true);
		expect(r.findings.find((f) => f.kind === "unknown-ref")).toMatchObject({
			id: "R999",
			doc: { id: "T-2" },
		});
	});

	test("contributes is validated but never closes", () => {
		const r = evaluateCoverage(RULE, LEDGER, "id\treason\n", [
			doc("T-1", { contributes: ["R4", "R404"] }),
		]);
		expect(r.findings.filter((f) => f.kind === "unknown-ref")).toHaveLength(1);
		expect(
			r.findings.some((f) => f.kind === "uncovered" && f.id === "R4"),
		).toBe(true);
	});

	test("stale waivers: unknown row, not-open row, row a card already closes", () => {
		const r = evaluateCoverage(
			RULE,
			LEDGER,
			"id\treason\nZ9\tx\nR6\tx\nR4\tx\n",
			[doc("T-1", { closes: ["R4"] })],
		);
		const stale = r.findings.filter((f) => f.kind === "stale-waiver");
		expect(stale.map((f) => f.id)).toEqual(["Z9", "R6", "R4"]);
		expect(stale[2]?.message).toContain("T-1 closes it");
	});

	test("a column the rule names but the table lacks is a table error", () => {
		expect(() =>
			evaluateCoverage({ ...RULE, idColumn: "nope" }, LEDGER, undefined, []),
		).toThrow(CoverageTableError);
	});

	test("duplicate row ids are reported once and the first wins", () => {
		const r = evaluateCoverage(
			{ ...RULE, waivers: undefined },
			`${LEDGER}\nR4\tS1\t-\topen`,
			undefined,
			[doc("T-1", { closes: ["R1", "R4", "R5", "R7"] })],
		);
		expect(r.findings.map((f) => f.kind)).toEqual(["duplicate-row"]);
	});
});
