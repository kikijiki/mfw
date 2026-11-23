/** Path rules shared by the server guard and the login page. No server imports. */

/** The path below the base, or null when it is outside the app. */
export function relativePath(pathname: string, base: string): string | null {
	if (pathname === base.replace(/\/$/, "")) return "";
	return pathname.startsWith(base) ? pathname.slice(base.length) : null;
}

/** Where to go after login: a path inside the app, or the app's root. */
export function safeNext(next: string | null, base: string): string {
	if (!next || !next.startsWith("/") || /[\\\p{Cc}]/u.test(next)) return base;
	if (next.startsWith("//")) return base;
	let url: URL;
	try {
		url = new URL(next, "http://mfw.invalid");
	} catch {
		return base;
	}
	if (url.origin !== "http://mfw.invalid") return base;
	// Dot segments can normalise into `//host`, which a browser reads as another site.
	if (url.pathname.startsWith("//")) return base;
	const rel = relativePath(url.pathname, base);
	if (rel === null || rel === "login") return base;
	return `${url.pathname}${url.search}`;
}
