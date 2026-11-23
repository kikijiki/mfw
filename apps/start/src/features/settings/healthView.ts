import type { DoctorCheck, DoctorReport } from "@mfw/daemon/doctor/report";

export type HealthTone = "critical" | "warn" | "info" | "ok" | "neutral";

export function healthTone(check: DoctorCheck): HealthTone {
	if (check.status === "ok") return "ok";
	if (check.status === "skipped") return "neutral";
	return check.severity === "blocker"
		? "critical"
		: check.severity === "warn"
			? "warn"
			: "info";
}

export function healthLabel(check: DoctorCheck): string {
	if (check.status === "ok") return "ok";
	if (check.status === "skipped") return "skipped";
	return check.severity;
}

const RANK: Record<HealthTone, number> = {
	critical: 0,
	warn: 1,
	info: 2,
	neutral: 3,
	ok: 4,
};

/** Problems first, most severe at the top; report order within a severity. */
export function healthRows(report: DoctorReport): DoctorCheck[] {
	return report.checks
		.map((check, index) => ({ check, index }))
		.sort(
			(a, b) =>
				RANK[healthTone(a.check)] - RANK[healthTone(b.check)] ||
				a.index - b.index,
		)
		.map((row) => row.check);
}

export function healthHeadline(report: DoctorReport): string {
	const { blocker, warn, info, ok, skipped } = report.summary;
	return `${blocker} blocker${blocker === 1 ? "" : "s"}, ${warn} warning${warn === 1 ? "" : "s"}, ${info} note${info === 1 ? "" : "s"}, ${ok} ok, ${skipped} skipped`;
}
