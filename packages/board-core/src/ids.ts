/** Id grammar and slugging, generic across every document type. */

/** Filename slug from a title: lowercase, ascii-ish, dash-separated, capped. Cosmetic; the id identifies the document. */
export function slugify(title: string, max = 48): string {
	return title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
}

/** `<ID>-<slug>`, or `<ID>` if the title has no sluggable characters. */
export function slugName(id: string, title: string): string {
	const slug = slugify(title);
	return slug ? `${id}-${slug}` : id;
}

/** Digits only, no leading-zero restriction: a `pad`-ded id (`WH-0042`) and an
 * unpadded one (`MFW-42`) both parse the same way, so a project adopting
 * padding later doesn't strand its already-written ids. The `key` is mandatory:
 * every id is `<KEY>-<n>` (or `<KEY>-<SUFFIX>-<n>`), never a bare number. Ids
 * are permanent plain sequence ids: there is no split/suffix-letter form. */
export function idPattern(key: string, suffix?: string): RegExp {
	return suffix
		? new RegExp(`^${key}-${suffix}-[0-9]+$`)
		: new RegExp(`^${key}-[0-9]+$`);
}

/** `pad` zero-pads the number to at least that many digits (overflow past it
 * is never truncated, just wider: pad 4 gives "0001".."9999", "10000", ...). */
export function formatId(
	key: string,
	num: number,
	suffix?: string,
	pad?: number,
): string {
	const n = pad ? String(num).padStart(pad, "0") : String(num);
	return suffix ? `${key}-${suffix}-${n}` : `${key}-${n}`;
}

/** The numeric part of an id matching `key`/`suffix`'s grammar, or null if
 * `id` doesn't match at all. */
export function parseIdNum(
	key: string,
	suffix: string | undefined,
	id: string,
): number | null {
	if (!idPattern(key, suffix).test(id)) return null;
	const prefix = suffix ? `${key}-${suffix}-` : `${key}-`;
	const n = Number(id.slice(prefix.length));
	return Number.isSafeInteger(n) ? n : null;
}

/** Does `name` (a document's flat filename or directory name) belong to `id`? Anchored so `MFW-1` does not match `MFW-11-x`. */
export function nameMatchesId(name: string, id: string): boolean {
	const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
	return stem === id || stem.startsWith(`${id}-`);
}
