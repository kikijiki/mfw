import type { RelyingParty } from "@mfw/daemon/auth/webauthn";
import { parseAllowedHosts } from "./exposure";
import { requestContext } from "./request-guard";
import { ipLiteral } from "./trusted-proxy";

/**
 * The WebAuthn RP ID and origin for a request, from the external origin the
 * request guard established: the scheme is this server's TLS or a trusted
 * proxy's, and the host is a loopback name or an exact `MFW_ALLOWED_HOSTS`
 * entry (forwarded only by a trusted proxy). Nothing else a client sends is
 * used. Call it only after `checkRequest` has passed.
 *
 * Passkeys are refused on an IP address (browsers do not accept one as an RP
 * ID) and on plain HTTP anywhere but `localhost`.
 */
export function relyingPartyFor(
	req: Request,
	env: Record<string, string | undefined> = process.env,
): RelyingParty | { error: string } {
	const context = requestContext(req);
	const authority = context.authority;
	if (context.refusal || !authority)
		return { error: "the request's origin could not be established" };
	const { host, port } = authority;
	if (host.startsWith("[") || ipLiteral(host))
		return {
			error:
				"passkeys need a name, not an IP address: open mfw at http://localhost or at its HTTPS name",
		};
	if (host !== "localhost") {
		if (context.scheme !== "https:")
			return { error: "passkeys need HTTPS on any name but localhost" };
		// Defence in depth: the guard already required this.
		if (
			!parseAllowedHosts(env.MFW_ALLOWED_HOSTS).hosts.some(
				(h) => h.host === host,
			)
		)
			return { error: "this host is not listed in MFW_ALLOWED_HOSTS" };
	}
	const defaultPort = context.scheme === "https:" ? "443" : "80";
	const origin = `${context.scheme}//${host}${port && port !== defaultPort ? `:${port}` : ""}`;
	return { rpId: host, origin };
}
