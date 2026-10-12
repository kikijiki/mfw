import { HostConfigSchema, scanHostKeys } from "@mfw/daemon/host-registry";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

const hostId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);

/**
 * Registry SSH hosts (machine-wide, `$MFW_HOME/hosts.json`). Adding a host
 * never trusts it: the host key must be pinned explicitly (scan, verify the
 * fingerprint on the box, then pin), and a host is schedulable only after a
 * probe passes the trust minimum (no root, no passwordless sudo, bwrap on
 * shared hosts). The public key returned by `add` goes into the box user's
 * `~/.ssh/authorized_keys`; the private key never leaves this machine.
 */
export const hostsRouter = createTRPCRouter({
	list: publicProcedure.query(({ ctx }) => ctx.orchestrator.hosts.list()),

	/** Add or update a host; returns its public key for authorized_keys. */
	add: publicProcedure
		.input(HostConfigSchema)
		.mutation(({ ctx, input }) => ctx.orchestrator.hosts.put(input)),

	remove: publicProcedure
		.input(z.object({ id: hostId }).strict())
		.mutation(({ ctx, input }) => ctx.orchestrator.hosts.remove(input.id)),

	probe: publicProcedure
		.input(z.object({ id: hostId }).strict())
		.mutation(({ ctx, input }) => ctx.orchestrator.hosts.probe(input.id)),

	publicKey: publicProcedure
		.input(z.object({ id: hostId }).strict())
		.query(({ ctx, input }) =>
			ctx.orchestrator.hosts.registry.publicKey(input.id),
		),

	/** Offered keys with fingerprints, to verify on the box before pinning. */
	scanKeys: publicProcedure
		.input(
			z
				.object({
					address: z.string().min(1).max(253),
					port: z.number().int().min(1).max(65_535).default(22),
				})
				.strict(),
		)
		.mutation(({ input }) => scanHostKeys(input)),
});
