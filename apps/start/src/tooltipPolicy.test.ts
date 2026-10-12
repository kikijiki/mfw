import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * No native `title=` tooltips in UI source. The browser's tooltip clips at
 * corners, cannot be styled, is absent on touch and keyboard focus, and
 * lingers over what it describes. Use `Tip` / `TipSpan` (components/ui/
 * tooltip.tsx), or delete the tooltip when it only repeats visible text.
 *
 * `title=` is still how `Panel`, `Empty`, `ErrorState`, `ConfirmDialog`,
 * `Chip`, `Cost`, `Button` and `AppLink` take a heading or tooltip text: those
 * components never forward it to the DOM (Button, AppLink, Chip and Cost turn
 * it into a `Tip`). So the guard flags `title=` on a lowercase JSX tag only.
 * A real exception goes in `ALLOW` (a substring of the line), with a reason.
 */

const ROOT = import.meta.dir;

const ALLOW: Record<string, { lineIncludes: string; why: string }[]> = {
	// (none)
};

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name === "node_modules") continue;
			out.push(...sources(path));
		} else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) {
			out.push(path);
		}
	}
	return out;
}

/** 1-based line numbers where a DOM element (lowercase tag) takes `title=`. */
function nativeTitles(text: string): number[] {
	const hits: number[] = [];
	const opens: { at: number; name: string }[] = [];
	for (const m of text.matchAll(/<([A-Za-z][\w.]*)(?=[\s>])/g)) {
		opens.push({ at: m.index ?? 0, name: m[1] ?? "" });
	}
	let o = -1;
	for (const m of text.matchAll(/(?<![\w-])title=/g)) {
		const at = m.index ?? 0;
		while (
			o + 1 < opens.length &&
			(opens[o + 1]?.at ?? Number.POSITIVE_INFINITY) < at
		)
			o++;
		const owner = opens[o]?.name ?? "";
		if (/^[a-z]/.test(owner)) {
			hits.push(text.slice(0, at).split("\n").length);
		}
	}
	return hits;
}

describe("no native title tooltips in UI source", () => {
	test("the detector flags DOM elements and spares components", () => {
		expect(nativeTitles('<span title="x">a</span>')).toEqual([1]);
		expect(nativeTitles('<a\n\thref="/"\n\ttitle={t}\n>a</a>')).toEqual([3]);
		expect(nativeTitles('<Panel title="Hosts">a</Panel>')).toEqual([]);
		expect(nativeTitles('<Button title="Stop">a</Button>')).toEqual([]);
		expect(nativeTitles('<TipSpan tip="x">a</TipSpan>')).toEqual([]);
	});

	test("apps/start/src non-test source has none", () => {
		const failures: string[] = [];
		for (const file of sources(ROOT)) {
			const rel = relative(ROOT, file);
			const text = readFileSync(file, "utf8");
			const lines = text.split("\n");
			for (const line of nativeTitles(text)) {
				const src = lines[line - 1] ?? "";
				const ok = (ALLOW[rel] ?? []).some((a) => src.includes(a.lineIncludes));
				if (!ok) failures.push(`${rel}:${line} ${src.trim()}`);
			}
		}
		expect(failures).toEqual([]);
	});

	test("no SVG <title> element either (it is a native tooltip too)", () => {
		const failures: string[] = [];
		for (const file of sources(ROOT)) {
			const text = readFileSync(file, "utf8");
			if (/<title[\s>]/.test(text)) failures.push(relative(ROOT, file));
		}
		expect(failures).toEqual([]);
	});
});
