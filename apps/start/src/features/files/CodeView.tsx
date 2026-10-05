import {
	LanguageDescription,
	type LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { BasicSetupOptions, Extension } from "@uiw/react-codemirror";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";

/**
 * Highlighted file view, client only. CodeMirror needs a real DOM, so importing
 * this into the SSR graph breaks the route; `FileViewer` loads it with a
 * dynamic `import()` in an effect and shows a plain `<pre>` until then (also
 * the fallback for unknown grammars and failed chunks).
 */

export interface CodeViewProps {
	/** Base-relative path; the grammar is chosen from it. */
	path: string;
	text: string;
	wrap: boolean;
}

export function CodeView({ path, text, wrap }: CodeViewProps) {
	const language = useLanguage(path);
	const dark = useDark();
	const extensions = useMemo(() => {
		const out: Extension[] = [SURFACE, EditorView.editable.of(false)];
		if (wrap) out.push(EditorView.lineWrapping);
		if (language) out.push(language);
		return out;
	}, [language, wrap]);

	return (
		<CodeMirror
			className="h-full"
			height="100%"
			value={text}
			// one-dark only when painting dark; SURFACE repaints chrome from `--mfw-*`.
			theme={dark ? oneDark : "light"}
			editable={false}
			readOnly
			indentWithTab={false}
			basicSetup={BASIC}
			extensions={extensions}
		/>
	);
}

/**
 * Observes what the document paints. Only `lib/theme` writes
 * `<html data-theme>` (absent means follow the OS, hence the media query).
 * Reading both avoids a second copy of the preference. Safe during render:
 * this module only loads in the browser.
 */
function useDark(): boolean {
	const [dark, setDark] = useState(painted);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const sync = () => setDark(painted());
		const observer = new MutationObserver(sync);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		media.addEventListener("change", sync);
		sync();
		return () => {
			observer.disconnect();
			media.removeEventListener("change", sync);
		};
	}, []);

	return dark;
}

/** Same resolution as `styles/tokens.css`, in JS. */
function painted(): boolean {
	const choice = document.documentElement.getAttribute("data-theme");
	if (choice === "dark") return true;
	if (choice === "light") return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Resolve the grammar for this file. `language-data` loads each grammar behind
 * its own dynamic import, so only the match is fetched. No match means plain text.
 */
function useLanguage(path: string): LanguageSupport | null {
	const [support, setSupport] = useState<LanguageSupport | null>(null);

	useEffect(() => {
		// Drop the previous grammar first; wrong highlighting is worse than none.
		setSupport(null);
		const name = path.slice(path.lastIndexOf("/") + 1);
		const found = LanguageDescription.matchFilename(languages, name);
		if (!found) return;

		let alive = true;
		void found
			.load()
			.then((loaded) => {
				if (alive) setSupport(loaded);
			})
			// A failed chunk leaves plain text.
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [path]);

	return support;
}

/**
 * Repaints background, gutters and hairlines from `--mfw-*` tokens (which
 * follow light/dark themselves). User extensions come after the theme, so this
 * wins over both themes. Syntax colours stay with CodeMirror.
 */
const SURFACE = EditorView.theme({
	"&": {
		height: "100%",
		background: "transparent",
		color: "var(--mfw-fg)",
		fontSize: "var(--mfw-text-xs)",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		fontFamily: "var(--mfw-font-mono)",
		lineHeight: "var(--mfw-leading-data)",
	},
	".cm-gutters": {
		background: "transparent",
		color: "var(--mfw-fg-faint)",
		border: "none",
		borderRight: "1px solid var(--mfw-border)",
	},
	".cm-activeLineGutter": { background: "transparent" },
	// Read-only: no caret.
	".cm-cursor, .cm-dropCursor": { display: "none" },
});

/**
 * A viewer, not an editor. Keymaps are off because the page owns its keyboard
 * (`?`, `j`/`k`); `drawSelection` is off so copying uses the browser selection.
 */
const BASIC = {
	lineNumbers: true,
	highlightSpecialChars: true,
	syntaxHighlighting: true,
	foldGutter: false,
	drawSelection: false,
	dropCursor: false,
	allowMultipleSelections: false,
	indentOnInput: false,
	bracketMatching: false,
	closeBrackets: false,
	autocompletion: false,
	rectangularSelection: false,
	crosshairCursor: false,
	highlightActiveLine: false,
	highlightActiveLineGutter: false,
	highlightSelectionMatches: false,
	history: false,
	defaultKeymap: false,
	historyKeymap: false,
	searchKeymap: false,
	foldKeymap: false,
	completionKeymap: false,
	lintKeymap: false,
	closeBracketsKeymap: false,
} satisfies BasicSetupOptions;
