import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * No emoji or symbol glyphs in UI source. Fonts render these as colourful OS
 * emoji or mismatched fallback glyphs, so every state/marker mark is an SVG
 * from `components/icons/glyphs.ts` (lucide) instead. Plain typography stays
 * (`…`, `·`, `→`, `×`, `−`, `—`, `§`, `›`, and the keycap symbols `⌘ ⌥ ⇧ ⏎`).
 *
 * The test reads every non-test .ts/.tsx under apps/start/src, both literal
 * characters and `\uXXXX` / `\u{...}` escapes, and fails on a denylisted
 * code point. A genuine exception goes in `ALLOW`, with a reason.
 */

/** Inclusive code point ranges that are never allowed in source. */
const DENY: readonly [number, number, string][] = [
	[0x1f000, 0x1faff, "emoji and pictographs"],
	[0x2190 + 0x10, 0x21e6, "arrows (use a lucide icon)"],
	[0x21e8, 0x21ff, "arrows (use a lucide icon)"],
	[0x2295, 0x22ff, "mathematical operators used as marks"],
	[0x2300, 0x2317, "misc technical"],
	[0x2319, 0x2324, "misc technical"],
	[0x2326, 0x23cd, "misc technical"],
	[0x23cf, 0x23ff, "media controls and misc technical (not the return key)"],
	[0x2440, 0x245f, "OCR symbols"],
	[0x25a0, 0x25ff, "geometric shapes"],
	[0x2600, 0x27bf, "misc symbols and dingbats"],
	[0x2900, 0x297f, "supplemental arrows"],
	[0x29d6, 0x29d9, "hourglass-like operators"],
	[0x2b00, 0x2bff, "misc symbols and arrows"],
	[0xfe0f, 0xfe0f, "emoji presentation selector"],
	[0x200d, 0x200d, "zero-width joiner (emoji sequences)"],
];

/** `relative/path.tsx` -> code points allowed there, with the reason. */
const ALLOW: Record<string, { points: number[]; why: string }> = {
	// (none)
};

const ROOT = import.meta.dir;

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name === "node_modules") continue;
			out.push(...sources(path));
		} else if (
			/\.(ts|tsx)$/.test(name) &&
			!/\.test\.(ts|tsx)$/.test(name) &&
			name !== "routeTree.gen.ts"
		) {
			out.push(path);
		}
	}
	return out;
}

function denied(cp: number): string | null {
	for (const [lo, hi, why] of DENY) if (cp >= lo && cp <= hi) return why;
	return null;
}

/** Every code point in `text`, including those spelled as escapes. */
function* points(text: string): Generator<{ cp: number; at: number }> {
	for (let i = 0; i < text.length; ) {
		const cp = text.codePointAt(i) ?? 0;
		yield { cp, at: i };
		i += cp > 0xffff ? 2 : 1;
	}
	const esc = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g;
	for (const m of text.matchAll(esc)) {
		yield { cp: Number.parseInt(m[1] ?? m[2] ?? "0", 16), at: m.index ?? 0 };
	}
}

function scan(text: string, allowed: number[] = []) {
	const found: string[] = [];
	for (const { cp, at } of points(text)) {
		if (allowed.includes(cp)) continue;
		const why = denied(cp);
		if (!why) continue;
		const line = text.slice(0, at).split("\n").length;
		found.push(
			`line ${line}: U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${why})`,
		);
	}
	return found;
}

describe("no emoji or symbol glyphs in UI source", () => {
	test("the denylist catches what it should (and spares typography)", () => {
		expect(scan("\u{1F44B}")).toHaveLength(1);
		expect(scan("✋")).toHaveLength(1);
		expect(scan("a ◆ b")).toHaveLength(1);
		expect(scan("\\u2691")).toHaveLength(1);
		expect(scan("✓ ✗")).toHaveLength(2);
		expect(scan("↻")).toHaveLength(1);
		expect(scan("… · → × — § ⌘ ⇧ ⏎")).toEqual([]);
	});

	test("apps/start/src non-test source has none", () => {
		const failures: string[] = [];
		for (const file of sources(ROOT)) {
			const rel = relative(ROOT, file);
			const allow = ALLOW[rel];
			for (const hit of scan(readFileSync(file, "utf8"), allow?.points)) {
				failures.push(`${rel} ${hit}`);
			}
		}
		expect(failures).toEqual([]);
	});
});
