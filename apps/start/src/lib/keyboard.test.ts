import { afterEach, describe, expect, test } from "bun:test";

import {
	activeBindings,
	describeKey,
	handleKeyDown,
	type KeyBinding,
	keySteps,
	matchSequence,
	registerScope,
	resetSequence,
	SEQUENCE_TIMEOUT_MS,
} from "./keyboard";

/** A keydown with just what the handler reads; no DOM needed. */
function press(
	key: string,
	opts: { meta?: boolean; shift?: boolean; at?: number } = {},
): { prevented: boolean } {
	const out = { prevented: false };
	const event = {
		key,
		metaKey: opts.meta ?? false,
		ctrlKey: false,
		altKey: false,
		shiftKey: opts.shift ?? false,
		isComposing: false,
		target: null,
		preventDefault: () => {
			out.prevented = true;
		},
	} as unknown as KeyboardEvent;
	handleKeyDown(event, opts.at);
	return out;
}

const disposers: Array<() => void> = [];
function scope(bindings: KeyBinding[]) {
	disposers.push(registerScope(bindings));
}
afterEach(() => {
	for (const d of disposers.splice(0)) d();
	resetSequence();
});

const binding = (key: string, run: () => void, extra?: Partial<KeyBinding>) =>
	({ key, label: key, run, ...extra }) satisfies KeyBinding;

describe("sequence parsing", () => {
	test("steps split on whitespace and normalize like single keys", () => {
		expect(keySteps("g h")).toEqual(["g", "h"]);
		expect(keySteps("g  H")).toEqual(["g", "shift+h"]);
		expect(keySteps("mod+k")).toEqual(["mod+k"]);
		expect(keySteps("j")).toEqual(["j"]);
		expect(keySteps(" ")).toEqual([" "]);
	});

	test("matchSequence tells none, prefix and full", () => {
		expect(matchSequence("g h", ["g"])).toBe("prefix");
		expect(matchSequence("g h", ["g", "h"])).toBe("full");
		expect(matchSequence("g h", ["g", "b"])).toBe("none");
		expect(matchSequence("g h", ["h"])).toBe("none");
		expect(matchSequence("g h", ["g", "h", "x"])).toBe("none");
		expect(matchSequence("g h", [])).toBe("none");
		expect(matchSequence("j", ["j"])).toBe("full");
		expect(matchSequence("mod+k", ["mod+k"])).toBe("full");
	});
});

describe("sequences dispatch", () => {
	test("g then h runs the binding, once, on the second key", () => {
		let ran = 0;
		scope([binding("g h", () => ran++)]);
		expect(press("g").prevented).toBe(true);
		expect(ran).toBe(0);
		press("h");
		expect(ran).toBe(1);
		// The sequence is spent: a bare h does nothing.
		press("h");
		expect(ran).toBe(1);
	});

	test("g b and g f are distinct from g h", () => {
		const hits: string[] = [];
		scope([
			binding("g h", () => hits.push("home")),
			binding("g b", () => hits.push("board")),
			binding("g f", () => hits.push("flow")),
		]);
		press("g");
		press("b");
		press("g");
		press("f");
		press("g");
		press("h");
		expect(hits).toEqual(["board", "flow", "home"]);
	});

	test("a wrong second key abandons the sequence and is a fresh key", () => {
		const hits: string[] = [];
		scope([
			binding("g h", () => hits.push("home")),
			binding("x", () => hits.push("x")),
		]);
		press("g");
		press("x");
		expect(hits).toEqual(["x"]);
		press("h");
		expect(hits).toEqual(["x"]);
	});

	test("the sequence times out", () => {
		let ran = 0;
		scope([binding("g h", () => ran++)]);
		press("g", { at: 1000 });
		press("h", { at: 1000 + SEQUENCE_TIMEOUT_MS + 1 });
		expect(ran).toBe(0);
		press("g", { at: 5000 });
		press("h", { at: 5000 + SEQUENCE_TIMEOUT_MS - 1 });
		expect(ran).toBe(1);
	});

	test("Escape abandons a half-typed sequence", () => {
		let ran = 0;
		scope([binding("g h", () => ran++)]);
		press("g");
		press("Escape");
		press("h");
		expect(ran).toBe(0);
	});

	test("an unrelated key is not swallowed when no sequence starts with it", () => {
		scope([binding("g h", () => {})]);
		expect(press("z").prevented).toBe(false);
	});

	test("a single-key binding on the same first key still wins", () => {
		const hits: string[] = [];
		scope([binding("g h", () => hits.push("seq"))]);
		scope([binding("g", () => hits.push("single"))]);
		press("g");
		expect(hits).toEqual(["single"]);
	});

	test("the innermost scope wins a completed sequence", () => {
		const hits: string[] = [];
		scope([binding("g h", () => hits.push("outer"))]);
		scope([binding("g h", () => hits.push("inner"))]);
		press("g");
		press("h");
		expect(hits).toEqual(["inner"]);
	});

	test("a disabled sequence does not arm", () => {
		scope([binding("g h", () => {}, { enabled: false })]);
		expect(press("g").prevented).toBe(false);
	});

	test("modifier chords still work alongside sequences", () => {
		let ran = 0;
		scope([binding("mod+k", () => ran++), binding("g h", () => {})]);
		press("k", { meta: true });
		expect(ran).toBe(1);
	});
});

describe("cheat sheet", () => {
	test("a sequence is listed once and read as 'then'", () => {
		scope([binding("g h", () => {}, { label: "Home", group: "Go" })]);
		const listed = activeBindings().filter((b) => b.key === "g h");
		expect(listed).toHaveLength(1);
		expect(describeKey("g h")).toBe("G then H");
		expect(describeKey("g f")).toBe("G then F");
	});

	test("single keys and chords read as before", () => {
		expect(describeKey("j")).toBe("J");
		expect(describeKey("Enter")).toBe("Enter");
		expect(describeKey("mod+s")).toMatch(/S$/);
	});
});
