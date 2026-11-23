/**
 * A request whose Host cannot form a URL (`Host: localhost:99999`, HTTP/1.0 with
 * no Host) fails inside the framework, before any route or guard runs. It was
 * already refused; this makes it the client error it is. Returning nothing
 * leaves every other error to the default handler.
 */
export function badRequestForUnparseableUrl(
	error: unknown,
): Response | undefined {
	const seen = new Set<unknown>();
	let e = error as { message?: unknown; cause?: unknown } | null | undefined;
	while (e && typeof e === "object" && !seen.has(e)) {
		seen.add(e);
		if (
			typeof e.message === "string" &&
			/cannot be parsed as a URL/.test(e.message)
		)
			return new Response(
				"mfw-request-refused: malformed request target or Host\n",
				{
					status: 400,
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						"X-Content-Type-Options": "nosniff",
						"Cache-Control": "no-store",
					},
				},
			);
		e = e.cause as typeof e;
	}
	return undefined;
}

export default badRequestForUnparseableUrl;
