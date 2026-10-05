/**
 * Minimal 5-field cron matcher for lifetime-task schedules (ARCHITECTURE.md §4.4).
 * Fields: minute hour day-of-month month day-of-week.
 * Supports: *  a  a-b  a,b,c  *​/n  a-b/n  (day-of-week 0 or 7 = Sunday).
 */
function parseField(spec: string, min: number, max: number): Set<number> {
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart ? parseInt(stepPart, 10) : 1;
		let lo = min,
			hi = max;
		if (rangePart && rangePart !== "*") {
			const [aParsed, bParsed] = rangePart.split("-");
			lo = parseInt(aParsed as string, 10);
			hi = bParsed !== undefined ? parseInt(bParsed, 10) : lo;
		}
		if (
			Number.isNaN(lo) ||
			Number.isNaN(hi) ||
			Number.isNaN(step) ||
			step < 1
		) {
			throw new Error(`invalid cron field '${spec}'`);
		}
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return out;
}

export interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
}

export function parseCron(expr: string): CronFields {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5)
		throw new Error(`cron must have 5 fields, got ${parts.length}`);
	const dow = parseField(parts[4] as string, 0, 7);
	if (dow.has(7)) dow.add(0);
	return {
		minute: parseField(parts[0] as string, 0, 59),
		hour: parseField(parts[1] as string, 0, 23),
		dom: parseField(parts[2] as string, 1, 31),
		month: parseField(parts[3] as string, 1, 12),
		dow,
	};
}

/** Does `date` (local time) match the cron expression? Second-precision ignored. */
export function cronMatches(expr: string, date: Date): boolean {
	const f = parseCron(expr);
	return (
		f.minute.has(date.getMinutes()) &&
		f.hour.has(date.getHours()) &&
		f.dom.has(date.getDate()) &&
		f.month.has(date.getMonth() + 1) &&
		f.dow.has(date.getDay())
	);
}
