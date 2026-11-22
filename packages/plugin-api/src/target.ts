import { isIP } from "node:net";
import { z } from "zod";

/**
 * Execution targets are core only: `local` and `ssh`. A third-party target
 * would decide what a run can touch, so no plugin implements one. What a
 * machine plugin supplies is an endpoint, and the host validates it here
 * before the seed bundle goes anywhere.
 */

export const EXECUTION_TARGET_KINDS = ["local", "ssh"] as const;
export type ExecutionTargetKind = (typeof EXECUTION_TARGET_KINDS)[number];

/**
 * Where a host key came from. RunPod is `tofu` today (`ssh-keyscan` over the
 * network): pinning afterwards stops later substitution, not a first-
 * connection interception, so `tofu` machines receive no workload secrets.
 */
export const HostKeySourceSchema = z.enum([
	"pinned-by-owner",
	"provider-attested",
	"tofu",
]);
export type HostKeySource = z.infer<typeof HostKeySourceSchema>;

export const MachineEndpointSchema = z.object({
	host: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65_535),
	/** OpenSSH public key line, when the plugin can attest one. */
	hostKey: z.string().max(2_048).optional(),
	hostKeySource: HostKeySourceSchema,
});
export type MachineEndpoint = z.infer<typeof MachineEndpointSchema>;

export type EndpointVerdict =
	| { ok: true }
	| { ok: false; reason: string; fix?: string };

const refuse = (reason: string): EndpointVerdict => ({
	ok: false,
	reason,
	fix: "list the host in the owner's static ssh hosts if it is intended",
});

function v4Octets(host: string): number[] {
	return host.split(".").map(Number);
}

function refusedV4(o: number[]): string | null {
	const [a = 0, b = 0] = o;
	if (a === 0) return "this-network address";
	if (a === 10) return "private range 10.0.0.0/8";
	if (a === 127) return "loopback";
	if (a === 100 && b >= 64 && b <= 127) return "shared address space";
	if (a === 169 && b === 254) return "link-local or metadata range";
	if (a === 172 && b >= 16 && b <= 31) return "private range 172.16.0.0/12";
	if (a === 192 && b === 168) return "private range 192.168.0.0/16";
	if (a === 192 && b === 0 && o[2] === 0) return "protocol assignment range";
	if (a >= 224) return "multicast or reserved range";
	return null;
}

function refusedV6(host: string): string | null {
	const h = host.toLowerCase();
	if (h === "::" || h === "::1") return "loopback or unspecified";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
	if (mapped) return refusedV4(v4Octets(mapped[1] as string));
	if (/^::ffff:[0-9a-f:]+$/.test(h)) return "ipv4-mapped address";
	const first = Number.parseInt(h.split(":")[0] || "0", 16);
	if ((first & 0xffc0) === 0xfe80) return "link-local";
	if ((first & 0xfe00) === 0xfc00) return "unique-local";
	if ((first & 0xff00) === 0xff00) return "multicast";
	return null;
}

const LOCAL_NAMES = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/];

/**
 * Host-side validation of a plugin-supplied endpoint: loopback, link-local,
 * private and metadata ranges are refused, as are non-canonical numeric hosts
 * (`2130706433`, `0x7f.1`) that a resolver would read as an address.
 *
 * `ownerListed` is the owner's `static-ssh` host list; a listed host passes
 * without range checks, because the owner named it. This is a pure check on
 * the literal. Resolving a name once, pinning the answer and re-checking it
 * is the egress layer's job.
 */
export function validateMachineEndpoint(
	endpoint: MachineEndpoint,
	ownerListed: readonly string[] = [],
): EndpointVerdict {
	const parsed = MachineEndpointSchema.safeParse(endpoint);
	if (!parsed.success) return refuse("endpoint is malformed");
	const raw = parsed.data.host.trim();
	const host = raw.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	if (ownerListed.some((h) => h.toLowerCase() === host)) return { ok: true };
	if (host.endsWith(".")) return refuse("host has a trailing dot");
	const family = isIP(host);
	if (family === 4) {
		const why = refusedV4(v4Octets(host));
		return why ? refuse(why) : { ok: true };
	}
	if (family === 6) {
		const why = refusedV6(host);
		return why ? refuse(why) : { ok: true };
	}
	if (host.includes(":")) return refuse("host is not a valid address");
	// inet_aton reads a name whose last label is numeric (or 0x-hex) as an address.
	if (/(^|\.)(0x[0-9a-f]*|[0-9]+)$/.test(host))
		return refuse("non-canonical numeric host");
	if (
		!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(
			host,
		)
	)
		return refuse("host is not a fully qualified name");
	if (LOCAL_NAMES.some((re) => re.test(host))) return refuse("local name");
	return { ok: true };
}

/** Whether a machine may receive workload secrets (never on `tofu`). */
export function mayReceiveWorkloadSecrets(source: HostKeySource): boolean {
	return source !== "tofu";
}
