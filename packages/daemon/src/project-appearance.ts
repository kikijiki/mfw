/**
 * A project's display options (`icon`, `color`), pure and dependency free so
 * the daemon validates with the same rules the UI picker offers.
 *
 * `icon` is a curated key (see `PROJECT_ICON_KEYS`, every key is 3+ letters)
 * OR a short text mark of 1-2 characters the user typed (letters, digits, or
 * an emoji they chose themselves; no whitespace or control characters).
 * Because keys are never shorter than 3 characters and marks never longer
 * than 2, the two cannot collide. `color` is a swatch key, never a raw value.
 * Both are optional: absent means "derive a monogram and colour from the name".
 */

export const PROJECT_ICON_KEYS = [
	"folder",
	"code",
	"terminal",
	"server",
	"database",
	"globe",
	"cpu",
	"flask",
	"book",
	"music",
	"gamepad",
	"rocket",
	"wrench",
	"shield",
	"chart",
	"cloud",
	"package",
	"layers",
	"box",
	"cog",
	"bug",
	"brain",
	"leaf",
	"star",
	"heart",
	"home",
	"camera",
	"image",
	"film",
	"mail",
	"chat",
	"key",
	"lock",
	"map",
	"compass",
	"calendar",
	"clock",
	"bolt",
	"flag",
	"tag",
	"cart",
	"wallet",
	"phone",
	"palette",
] as const;

export type ProjectIconKey = (typeof PROJECT_ICON_KEYS)[number];

export const PROJECT_COLOR_KEYS = [
	"slate",
	"red",
	"orange",
	"amber",
	"green",
	"teal",
	"blue",
	"indigo",
	"violet",
	"pink",
] as const;

export type ProjectColorKey = (typeof PROJECT_COLOR_KEYS)[number];

/** The longest text mark, in user-perceived characters. */
export const PROJECT_MARK_MAX = 2;

const ICON_KEYS: ReadonlySet<string> = new Set(PROJECT_ICON_KEYS);
const COLOR_KEYS: ReadonlySet<string> = new Set(PROJECT_COLOR_KEYS);

export function isProjectIconKey(value: string): value is ProjectIconKey {
	return ICON_KEYS.has(value);
}

export function isProjectColorKey(value: string): value is ProjectColorKey {
	return COLOR_KEYS.has(value);
}

function graphemes(text: string): string[] {
	const Seg = (
		Intl as unknown as {
			Segmenter?: new (
				l?: string,
				o?: { granularity: "grapheme" },
			) => { segment(s: string): Iterable<{ segment: string }> };
		}
	).Segmenter;
	if (!Seg) return Array.from(text);
	return Array.from(
		new Seg(undefined, { granularity: "grapheme" }).segment(text),
		(s) => s.segment,
	);
}

/** A 1-2 character mark with no whitespace or control characters. */
export function isProjectTextMark(value: string): boolean {
	if (value.length === 0 || value.length > 16) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\s\u0000-\u001f\u007f]/u.test(value)) return false;
	const n = graphemes(value).length;
	return n >= 1 && n <= PROJECT_MARK_MAX;
}

/** Why `icon` is refused, or null when it is a key or a text mark. */
export function iconProblem(icon: string): string | null {
	if (isProjectIconKey(icon) || isProjectTextMark(icon)) return null;
	if (icon.length >= 3 && /^[a-z-]+$/.test(icon)) {
		return `unknown icon "${icon}": pick one of ${PROJECT_ICON_KEYS.join(", ")}, or type a mark of at most ${PROJECT_MARK_MAX} characters`;
	}
	return `icon text mark must be 1-${PROJECT_MARK_MAX} characters with no spaces`;
}

export function colorProblem(color: string): string | null {
	return isProjectColorKey(color)
		? null
		: `unknown colour "${color}": pick one of ${PROJECT_COLOR_KEYS.join(", ")}`;
}

/** Throws a plain Error naming the problem; used before anything is persisted. */
export function assertAppearance(a: {
	icon?: string | null;
	color?: string | null;
}): void {
	if (a.icon != null) {
		const p = iconProblem(a.icon);
		if (p) throw new Error(p);
	}
	if (a.color != null) {
		const p = colorProblem(a.color);
		if (p) throw new Error(p);
	}
}

/** How a project is drawn. `kind: "key"` names a curated glyph, `"text"` is letters. */
export interface ResolvedAvatar {
	kind: "key" | "text";
	/** Icon key for `kind: "key"`, else the characters shown. */
	value: string;
	/** A swatch key. */
	color: ProjectColorKey;
	/** True when the user chose the icon or colour (false = derived from the name). */
	custom: boolean;
}

/** Deterministic hash, stable across sessions. */
function hash(name: string): number {
	let h = 5381;
	for (let i = 0; i < name.length; i++) {
		h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
	}
	return h;
}

/** First one or two letters/digits of the name (initials of the first two words when it has them). */
export function monogramOf(name: string): string {
	const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	if (words.length === 0) return "?";
	const first = graphemes(words[0] as string);
	const second = words[1] ? graphemes(words[1]) : [];
	const text =
		second.length > 0 ? `${first[0]}${second[0]}` : first.slice(0, 2).join("");
	return text.toUpperCase();
}

/** The derived colour for a name; neutral slate is skipped so projects differ from chrome. */
export function colorOf(name: string): ProjectColorKey {
	const pool = PROJECT_COLOR_KEYS.filter((c) => c !== "slate");
	return pool[hash(name) % pool.length] as ProjectColorKey;
}

/** Unset or invalid stored values fall back to the derived monogram and colour. */
export function resolveAvatar(
	name: string,
	options?: { icon?: string | null; color?: string | null } | null,
): ResolvedAvatar {
	const icon = options?.icon ?? null;
	const color = options?.color ?? null;
	const usableColor = color && isProjectColorKey(color) ? color : null;
	let kind: ResolvedAvatar["kind"] = "text";
	let value = monogramOf(name);
	let customIcon = false;
	if (icon && isProjectIconKey(icon)) {
		kind = "key";
		value = icon;
		customIcon = true;
	} else if (icon && isProjectTextMark(icon)) {
		value = icon;
		customIcon = true;
	}
	return {
		kind,
		value,
		color: usableColor ?? colorOf(name),
		custom: customIcon || usableColor !== null,
	};
}
