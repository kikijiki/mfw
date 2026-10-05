import { useEffect, useRef } from "react";

/**
 * The keyboard registry: one `keydown` listener for the whole app. Features
 * declare bindings while mounted; conflicts resolve by recency (the most
 * recently mounted scope wins, so the dialog on top gets Escape). Every
 * binding is discoverable via `?`.
 */

export interface KeyBinding {
	/**
	 * `j`, `Enter`, `[`, `?`, `mod+s`, `shift+n`. `mod` is Cmd on macOS and
	 * Ctrl elsewhere, so a binding is written once.
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
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	if (tag === "TEXTAREA") return true;
	if (tag === "SELECT") return true;
	if (tag !== "INPUT") return false;
	const type = (target as HTMLInputElement).type;
	return !["checkbox", "radio", "button", "submit", "range"].includes(type);
}

function onKeyDown(e: KeyboardEvent): void {
	if (e.isComposing) return;
	const combo = eventCombo(e);
	const inText = isTextEntry(e.target);
	// Newest scope first: the innermost mounted surface owns the key.
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) continue;
		for (const binding of scope.bindings) {
			if (binding.enabled === false) continue;
			if (normalize(binding.key) !== combo) continue;
			if (inText && !binding.allowInInput && !combo.startsWith("mod")) continue;
			e.preventDefault();
			binding.run(e);
			return;
		}
	}
}

function attach(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	window.addEventListener("keydown", onKeyDown);
}

function detach(): void {
	if (!listening || scopes.length > 0) return;
	listening = false;
	window.removeEventListener("keydown", onKeyDown);
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

/** Pretty-print a binding for the cheat sheet: `mod+s` → `⌘S` / `Ctrl+S`. */
export function describeKey(key: string): string {
	const mac =
		typeof navigator !== "undefined" &&
		/Mac|iPhone|iPad/.test(navigator.platform);
	return key
		.split("+")
		.map((part) => {
			if (part === "mod") return mac ? "⌘" : "Ctrl";
			if (part === "shift") return mac ? "⇧" : "Shift";
			if (part === "alt") return mac ? "⌥" : "Alt";
			return part.length === 1 ? part.toUpperCase() : part;
		})
		.join(mac ? "" : "+");
}
