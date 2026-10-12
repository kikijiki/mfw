import { useEffect, useRef } from "react";
import { detectMac } from "./platform";

/**
 * The keyboard registry: one `keydown` listener for the whole app. Features
 * declare bindings while mounted; conflicts resolve by recency (the most
 * recently mounted scope wins, so the dialog on top gets Escape). Every
 * binding is discoverable via `?`.
 */

export interface KeyBinding {
	/**
	 * `j`, `Enter`, `[`, `?`, `mod+s`, `shift+n`. `mod` is Cmd on macOS and
	 * Ctrl elsewhere, so a binding is written once. A space separates the steps
	 * of a sequence: `g h` is two key presses in a row (see `SEQUENCE_TIMEOUT_MS`).
	 */
	key: string;
	/** Shown in the cheat sheet. Imperative voice: "Approve", "Next file". */
	label: string;
	/** Group heading in the cheat sheet. */
	group?: string;
	run: (event: KeyboardEvent) => void;
	/**
	 * Single-key shortcuts are swallowed by text inputs (typing `a` in a
	 * textarea must not approve a task). Chords with a modifier still fire, and
	 * a binding can opt in explicitly (`Escape`, `mod+Enter`).
	 */
	allowInInput?: boolean;
	/** A binding that is registered but currently inert (e.g. no selection). */
	enabled?: boolean;
	/** Hide from the cheat sheet without disabling it. */
	hidden?: boolean;
}

interface Scope {
	bindings: KeyBinding[];
}

const scopes: Scope[] = [];
let listening = false;

/** How long a half-typed sequence (`g` of `g h`) waits for its next key. */
export const SEQUENCE_TIMEOUT_MS = 1500;

/** The keys of an unfinished sequence, and when the last one was pressed. */
let pending: { combos: string[]; at: number } | null = null;

/** True for a character the Shift key produced a *letter* case change on. */
function isShiftedLetter(key: string): boolean {
	return key.length === 1 && key !== key.toLowerCase();
}

function normalize(key: string): string {
	const parts = key.split("+");
	const rawMain = parts.pop() ?? "";
	const mods = new Set(parts.map((p) => p.toLowerCase()));
	// `N` means shift+n; without this `n` and `N` would collide.
	if (isShiftedLetter(rawMain)) mods.add("shift");
	return [
		mods.has("mod") ? "mod" : null,
		mods.has("alt") ? "alt" : null,
		mods.has("shift") ? "shift" : null,
		rawMain.toLowerCase(),
	]
		.filter(Boolean)
		.join("+");
}

/** The steps of a binding key: `g h` is `["g", "h"]`, `mod+k` one step. A bare space is the Space key. */
export function keySteps(key: string): string[] {
	if (key.trim() === "") return [normalize(" ")];
	return key.trim().split(/\s+/).map(normalize);
}

export type SequenceMatch = "none" | "prefix" | "full";

/**
 * Does the run of pressed combos (already normalized, as `eventCombo` gives
 * them) spell this binding, or is it the start of it?
 */
export function matchSequence(
	key: string,
	pressed: readonly string[],
): SequenceMatch {
	const steps = keySteps(key);
	if (pressed.length === 0 || pressed.length > steps.length) return "none";
	for (let i = 0; i < pressed.length; i++) {
		if (steps[i] !== pressed[i]) return "none";
	}
	return pressed.length === steps.length ? "full" : "prefix";
}

function eventCombo(e: KeyboardEvent): string {
	const mods: string[] = [];
	if (e.metaKey || e.ctrlKey) mods.push("mod");
	if (e.altKey) mods.push("alt");
	// Shift counts only when it changed what the key produced (a named key or a
	// letter's case). `?` already is shift+/, so requiring `shift+?` would make
	// that binding unreachable.
	if (e.shiftKey && (e.key.length > 1 || isShiftedLetter(e.key))) {
		mods.push("shift");
	}
	return [...mods, e.key.toLowerCase()].join("+");
}

function isTextEntry(target: EventTarget | null): boolean {
	if (typeof HTMLElement === "undefined") return false;
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	if (tag === "TEXTAREA") return true;
	if (tag === "SELECT") return true;
	if (tag !== "INPUT") return false;
	const type = (target as HTMLInputElement).type;
	return !["checkbox", "radio", "button", "submit", "range"].includes(type);
}

/**
 * Try `pressed` against every enabled binding, newest scope first. A full
 * match runs; otherwise a prefix match arms the sequence. Returns whether the
 * key was consumed.
 */
function dispatch(
	e: KeyboardEvent,
	pressed: string[],
	inText: boolean,
	now: number,
): boolean {
	let sawPrefix = false;
	// Newest scope first: the innermost mounted surface owns the key.
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) continue;
		for (const binding of scope.bindings) {
			if (binding.enabled === false) continue;
			const m = matchSequence(binding.key, pressed);
			if (m === "none") continue;
			const first = pressed[0] ?? "";
			if (inText && !binding.allowInInput && !first.startsWith("mod")) continue;
			if (m === "prefix") {
				sawPrefix = true;
				continue;
			}
			pending = null;
			e.preventDefault();
			binding.run(e);
			return true;
		}
	}
	if (sawPrefix) {
		pending = { combos: pressed, at: now };
		e.preventDefault();
		return true;
	}
	return false;
}

/** The one key handler; exported so tests can drive it without a DOM. `now` is injectable for the sequence timeout. */
export function handleKeyDown(e: KeyboardEvent, now = Date.now()): void {
	if (e.isComposing) return;
	const combo = eventCombo(e);
	const inText = isTextEntry(e.target);
	if (pending && now - pending.at > SEQUENCE_TIMEOUT_MS) pending = null;
	if (pending) {
		const carried = [...pending.combos, combo];
		pending = null;
		// Escape abandons the half-typed sequence and nothing else.
		if (combo === "escape") return;
		if (dispatch(e, carried, inText, now)) return;
		// Not a continuation: the key is a fresh press.
	}
	dispatch(e, [combo], inText, now);
}

/** Forget a half-typed sequence (tests, and anything that moves focus away). */
export function resetSequence(): void {
	pending = null;
}

/** Register a scope without a component (tests, non-React callers); returns its disposer. */
export function registerScope(bindings: KeyBinding[]): () => void {
	const scope: Scope = { bindings };
	scopes.push(scope);
	attach();
	return () => {
		const i = scopes.indexOf(scope);
		if (i >= 0) scopes.splice(i, 1);
		detach();
	};
}

function onKeyDownEvent(e: KeyboardEvent): void {
	handleKeyDown(e);
}

function attach(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	window.addEventListener("keydown", onKeyDownEvent);
}

function detach(): void {
	if (!listening || scopes.length > 0) return;
	listening = false;
	window.removeEventListener("keydown", onKeyDownEvent);
}

/**
 * Declare the shortcuts a surface answers to while it is mounted.
 *
 * The binding array may be rebuilt every render (closures over fresh state);
 * only the scope's *position* is stable, so re-rendering never re-orders who
 * wins a key.
 */
export function useKeyBindings(bindings: KeyBinding[]): void {
	const scopeRef = useRef<Scope>({ bindings });
	scopeRef.current.bindings = bindings;

	useEffect(() => {
		const scope = scopeRef.current;
		scopes.push(scope);
		attach();
		return () => {
			const i = scopes.indexOf(scope);
			if (i >= 0) scopes.splice(i, 1);
			detach();
		};
	}, []);
}

/** Every binding currently registered, innermost scope first (for `?`). */
export function activeBindings(): KeyBinding[] {
	const out: KeyBinding[] = [];
	for (let i = scopes.length - 1; i >= 0; i--) {
		for (const b of scopes[i]?.bindings ?? []) {
			if (b.hidden || b.enabled === false) continue;
			if (out.some((existing) => existing.key === b.key)) continue;
			out.push(b);
		}
	}
	return out;
}

/**
 * Pretty-print a binding for the cheat sheet: `mod+s` is the command-key
 * symbol and `S` on macOS, `Ctrl+S` elsewhere. Pass `mac` (from `useIsMac`)
 * so a render matches what the server drew; it defaults to the live platform.
 * `spaced` joins non-Mac steps with a space (`Ctrl K`) for a compact hint.
 */
export function describeKey(
	key: string,
	mac: boolean = detectMac(),
	spaced = false,
): string {
	const step = (one: string) =>
		one
			.split("+")
			.map((part) => {
				if (part === "mod") return mac ? "⌘" : "Ctrl";
				if (part === "shift") return mac ? "⇧" : "Shift";
				if (part === "alt") return mac ? "⌥" : "Alt";
				return part.length === 1 ? part.toUpperCase() : part;
			})
			.join(mac ? "" : spaced ? " " : "+");
	// A sequence reads as "G then H"; a lone space is the Space key.
	const steps = key.trim() === "" ? [key] : key.trim().split(/\s+/);
	return steps.map(step).join(" then ");
}
