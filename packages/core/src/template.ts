/**
 * Task templates (`.mfw/templates/<type>.md`, falling back to `task.md`).
 *
 * A template is plain markdown: its `##` headings are the sections a task of
 * that type must fill in, and the text under each heading is guidance shown
 * to whoever writes the task (a human in the editor, a planner in its
 * prompt). A heading ending in `(optional)` names a section that may be left
 * out. The template is the only schema: there is no separate list of
 * required fields to keep in sync.
 *
 * `Acceptance Criteria` and `Verification checks` are machine-owned regions
 * of a task file (see `taskfile.ts`), so the parser strips them out of the
 * body. A template may still require them; they are then checked against the
 * parsed criteria and verification plan instead of the body.
 */

export interface TemplateSection {
	heading: string;
	required: boolean;
	/** The template's guidance text under the heading (trimmed). */
	guidance: string;
}

export interface TaskTemplate {
	/** The whole template text, for editors and prompts. */
	text: string;
	sections: TemplateSection[];
}

const H2_RE = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const OPTIONAL_RE = /\s*\(optional\)\s*$/i;

/** `## Heading` lines outside fences, with the text under each. */
function h2Sections(markdown: string): { heading: string; content: string }[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const out: { heading: string; content: string[] }[] = [];
	let fence: string | null = null;
	for (const line of lines) {
		const f = FENCE_RE.exec(line);
		if (f) {
			const delim = f[1] as string;
			if (fence === null) fence = delim;
			else if (
				delim.startsWith(fence[0] as string) &&
				delim.length >= fence.length
			)
				fence = null;
		}
		const h = fence === null && !f ? H2_RE.exec(line) : null;
		if (h) {
			out.push({ heading: (h[1] as string).trim(), content: [] });
		} else if (/^#[ \t]/.test(line) && fence === null) {
			// A level-1 heading ends the current section without starting one.
			out.push({ heading: "", content: [] });
		} else {
			out.at(-1)?.content.push(line);
		}
	}
	return out
		.filter((s) => s.heading.length > 0)
		.map((s) => ({ heading: s.heading, content: s.content.join("\n") }));
}

export function parseTaskTemplate(text: string): TaskTemplate {
	const sections = h2Sections(text).map(({ heading, content }) => ({
		heading: heading.replace(OPTIONAL_RE, "").trim(),
		required: !OPTIONAL_RE.test(heading),
		guidance: content.trim(),
	}));
	return { text, sections };
}

/** Headings compare case- and whitespace-insensitively. */
function key(heading: string): string {
	return heading
		.replace(OPTIONAL_RE, "")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
}

const CRITERIA_KEY = "acceptance criteria";
const VERIFICATION_KEYS = new Set([
	"verification checks",
	"definition of done",
]);

/** Visible text: HTML comments and whitespace do not count as content. */
function substantive(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * Required template sections the task leaves missing or empty. A section
 * whose content is still the template's own guidance counts as empty: copying
 * the placeholder is not filling it in.
 */
export function missingTemplateSections(
	template: TaskTemplate,
	task: { body: string; criteriaCount: number; hasVerification: boolean },
): string[] {
	const present = new Map<string, string>();
	for (const s of h2Sections(task.body)) {
		const k = key(s.heading);
		present.set(k, `${present.get(k) ?? ""}\n${s.content}`);
	}
	const missing: string[] = [];
	for (const section of template.sections) {
		if (!section.required) continue;
		const k = key(section.heading);
		if (k === CRITERIA_KEY) {
			if (task.criteriaCount === 0) missing.push(section.heading);
			continue;
		}
		if (VERIFICATION_KEYS.has(k)) {
			if (!task.hasVerification) missing.push(section.heading);
			continue;
		}
		const content = substantive(present.get(k) ?? "");
		if (content.length === 0 || content === substantive(section.guidance)) {
			missing.push(section.heading);
		}
	}
	return missing;
}
