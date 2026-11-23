import { describe, expect, test } from "bun:test";
import type { DoctorCheck, DoctorReport } from "@mfw/daemon/doctor/report";
import {
	healthHeadline,
	healthLabel,
	healthRows,
	healthTone,
} from "./healthView";

const check = (
	id: string,
	status: DoctorCheck["status"],
	severity: DoctorCheck["severity"] = "info",
): DoctorCheck => ({ id, group: "host", status, severity, detail: id });

const report = (checks: DoctorCheck[]): DoctorReport => ({
	schemaVersion: 1,
	ok: !checks.some((c) => c.status === "problem" && c.severity === "blocker"),
	summary: { blocker: 1, warn: 1, info: 0, ok: 1, skipped: 1 },
	checks,
});

describe("the health panel's view", () => {
	test("puts problems first, most severe at the top", () => {
		const rows = healthRows(
			report([
				check("fine", "ok"),
				check("skip", "skipped"),
				check("warned", "problem", "warn"),
				check("blocked", "problem", "blocker"),
			]),
		);
		expect(rows.map((r) => r.id)).toEqual([
			"blocked",
			"warned",
			"skip",
			"fine",
		]);
	});

	test("an ok check is never shown with a failing tone", () => {
		const c = check("fine", "ok", "blocker");
		expect(healthTone(c)).toBe("ok");
		expect(healthLabel(c)).toBe("ok");
	});

	test("the headline counts each severity", () => {
		expect(healthHeadline(report([]))).toBe(
			"1 blocker, 1 warning, 0 notes, 1 ok, 1 skipped",
		);
	});
});
