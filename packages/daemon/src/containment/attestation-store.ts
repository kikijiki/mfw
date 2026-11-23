/**
 * The sandbox attestation record (design "Probe barrier").
 *
 * Only the host writes a row, from what it observed over the probe's pipe.
 * Nothing here reads a file a sandbox could write. Rows are append-only: a
 * newer record for a run replaces an older one by being newer, so a failed
 * re-probe revokes an earlier pass.
 *
 * A row that does not parse reads as no attestation. It can never read as a
 * pass, whatever its `outcome` column says.
 */

import { randomUUID } from "node:crypto";
import type { ProjectDb } from "@mfw/db/client";
import { sandboxAttestations } from "@mfw/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

/** Bump when the probe's items or their meaning change: older rows stop counting. */
export const ATTESTATION_VERSION = 1;

const ItemSchema = z.strictObject({
	id: z.string().min(1),
	status: z.enum(["pass", "fail"]),
	detail: z.string(),
});

const RowSchema = z.object({
	id: z.string().min(1),
	runId: z.string().min(1),
	version: z.number().int(),
	profileHash: z.string().min(1),
	optionsHash: z.string().min(1),
	seccompHash: z.string().min(1),
	bwrapVersion: z.string().min(1),
	scope: z.enum(["systemd", "none"]),
	outcome: z.enum(["pass", "fail"]),
	items: z.array(ItemSchema).min(1),
	createdAt: z.date(),
});

export type AttestationItem = z.infer<typeof ItemSchema>;
export type Attestation = z.infer<typeof RowSchema>;
export type AttestationInput = Omit<Attestation, "id" | "version">;

/** Append a record and return its id. */
export async function recordAttestation(
	db: ProjectDb,
	input: AttestationInput,
): Promise<string> {
	const id = randomUUID();
	await db
		.insert(sandboxAttestations)
		.values({ ...input, id, version: ATTESTATION_VERSION });
	return id;
}

/** The run's newest record, or null when it has none or the row is malformed. */
export async function latestAttestation(
	db: ProjectDb,
	runId: string,
): Promise<Attestation | null> {
	const [row] = await db
		.select()
		.from(sandboxAttestations)
		.where(eq(sandboxAttestations.runId, runId))
		// Insertion order only. A wall clock that steps back must not let an
		// older pass outrank a newer failure.
		.orderBy(desc(sql`rowid`))
		.limit(1);
	if (!row) return null;
	const parsed = RowSchema.safeParse(row);
	return parsed.success ? parsed.data : null;
}
