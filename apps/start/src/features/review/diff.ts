/**
 * Side-by-side line diff for the review screen (`@codemirror/merge` is not a
 * dependency). Trims the common prefix/suffix, then runs an LCS on the rest.
 * The DP is capped: past it the file is reported as wholly replaced.
 */

export type DiffRowKind = "context" | "add" | "del" | "change";

export interface DiffRow {
	kind: DiffRowKind;
	/** 1-based line numbers, null on the side where the line does not exist. */
	oldLine: number | null;
	newLine: number | null;
	oldText: string | null;
	newText: string | null;
}

/** Max DP cells; ~4M takes a few tens of ms. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	// A trailing newline is a terminator, not an empty last line.
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function diffLines(oldText: string, newText: string): DiffRow[] {
	const a = splitLines(oldText);
	const b = splitLines(newText);

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}

	const rows: DiffRow[] = [];
	for (let i = 0; i < prefix; i++) {
		rows.push(context(i + 1, i + 1, a[i] ?? ""));
	}

	const midA = a.slice(prefix, a.length - suffix);
	const midB = b.slice(prefix, b.length - suffix);
	const ops =
		midA.length * midB.length > MAX_CELLS
			? coarseOps(midA.length, midB.length)
			: lcsOps(midA, midB);

	let ai = prefix;
	let bi = prefix;
	let pendingDel: { line: number; text: string }[] = [];
	let pendingAdd: { line: number; text: string }[] = [];

	const flush = () => {
		const n = Math.max(pendingDel.length, pendingAdd.length);
		for (let i = 0; i < n; i++) {
			const del = pendingDel[i];
			const add = pendingAdd[i];
			if (del && add) {
				rows.push({
					kind: "change",
					oldLine: del.line,
					newLine: add.line,
					oldText: del.text,
					newText: add.text,
				});
			} else if (del) {
				rows.push({
					kind: "del",
					oldLine: del.line,
					newLine: null,
					oldText: del.text,
					newText: null,
				});
			} else if (add) {
				rows.push({
					kind: "add",
					oldLine: null,
					newLine: add.line,
					oldText: null,
					newText: add.text,
				});
			}
		}
		pendingDel = [];
		pendingAdd = [];
	};

	for (const op of ops) {
		if (op === "same") {
			flush();
			rows.push(context(ai + 1, bi + 1, a[ai] ?? ""));
			ai++;
			bi++;
		} else if (op === "del") {
			pendingDel.push({ line: ai + 1, text: a[ai] ?? "" });
			ai++;
		} else {
			pendingAdd.push({ line: bi + 1, text: b[bi] ?? "" });
			bi++;
		}
	}
	flush();

	for (let i = 0; i < suffix; i++) {
		const oldLine = a.length - suffix + i + 1;
		const newLine = b.length - suffix + i + 1;
		rows.push(context(oldLine, newLine, a[oldLine - 1] ?? ""));
	}

	return rows;
}

function context(oldLine: number, newLine: number, text: string): DiffRow {
	return {
		kind: "context",
		oldLine,
		newLine,
		oldText: text,
		newText: text,
	};
}

type Op = "same" | "del" | "add";

/** Everything replaced; used when the DP would be too big. */
function coarseOps(dels: number, adds: number): Op[] {
	const ops: Op[] = [];
	for (let i = 0; i < dels; i++) ops.push("del");
	for (let i = 0; i < adds; i++) ops.push("add");
	return ops;
}

function lcsOps(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) return coarseOps(0, m);
	if (m === 0) return coarseOps(n, 0);

	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? (dp[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push("same");
			i++;
			j++;
		} else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
			ops.push("del");
			i++;
		} else {
			ops.push("add");
			j++;
		}
	}
	while (i < n) {
		ops.push("del");
		i++;
	}
	while (j < m) {
		ops.push("add");
		j++;
	}
	return ops;
}

export interface DiffGap {
	kind: "gap";
	/** Rows hidden behind this marker, in order. */
	rows: DiffRow[];
}
export interface DiffChunk {
	kind: "rows";
	rows: DiffRow[];
	/** True when this chunk contains at least one changed line (hunk nav). */
	changed: boolean;
}
export type DiffBlock = DiffGap | DiffChunk;

/** Collapse long unchanged stretches, keeping `contextLines` either side of every change. */
export function collapse(rows: DiffRow[], contextLines = 3): DiffBlock[] {
	const keep = new Uint8Array(rows.length);
	for (let i = 0; i < rows.length; i++) {
		if (rows[i]?.kind === "context") continue;
		const from = Math.max(0, i - contextLines);
		const to = Math.min(rows.length - 1, i + contextLines);
		for (let j = from; j <= to; j++) keep[j] = 1;
	}

	const blocks: DiffBlock[] = [];
	let buffer: DiffRow[] = [];
	let bufferKept = rows.length > 0 ? keep[0] === 1 : true;

	const flush = () => {
		if (buffer.length === 0) return;
		if (bufferKept) {
			blocks.push({
				kind: "rows",
				rows: buffer,
				changed: buffer.some((r) => r.kind !== "context"),
			});
		} else {
			blocks.push({ kind: "gap", rows: buffer });
		}
		buffer = [];
	};

	for (let i = 0; i < rows.length; i++) {
		const kept = keep[i] === 1;
		if (kept !== bufferKept) {
			flush();
			bufferKept = kept;
		}
		const row = rows[i];
		if (row) buffer.push(row);
	}
	flush();
	return blocks;
}

export function countChanges(rows: readonly DiffRow[]): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.kind === "add") added++;
		else if (row.kind === "del") removed++;
		else if (row.kind === "change") {
			added++;
			removed++;
		}
	}
	return { added, removed };
}
