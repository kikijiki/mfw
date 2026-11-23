import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { sandboxAttestations } from "@mfw/db/schema";
import { eq, sql } from "drizzle-orm";
import {
	ATTESTATION_VERSION,
	type AttestationInput,
	latestAttestation,
	recordAttestation,
} from "../src/containment/attestation-store.ts";

/** The attestation row: versioned, append-only, read back typed. */

let dir: string;
let handle: ProjectDbHandle;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "mfw-attestation-"));
	handle = await openProjectDb(dir);
});

afterAll(async () => {
	handle.close();
	await rm(dir, { recursive: true, force: true });
});

/** Whether the database refused the statement. Drizzle queries are only thenable. */
async function refused(query: PromiseLike<unknown>): Promise<boolean> {
	try {
		await query;
		return false;
	} catch {
		return true;
	}
}

const input = (over: Partial<AttestationInput> = {}): AttestationInput => ({
	runId: "run-1",
	profileHash: "p".repeat(64),
	optionsHash: "o".repeat(64),
	seccompHash: "s".repeat(64),
	bwrapVersion: "0.13.1",
	scope: "systemd",
	outcome: "pass",
	items: [{ id: "caps_empty", status: "pass", detail: "no capabilities" }],
	createdAt: new Date(1_000),
	...over,
});

describe("attestation store", () => {
	test("round-trips a record with its version and per-item results", async () => {
		const id = await recordAttestation(handle.db, input());
		const row = await latestAttestation(handle.db, "run-1");
		expect(row?.id).toBe(id);
		expect(row?.version).toBe(ATTESTATION_VERSION);
		expect(row?.outcome).toBe("pass");
		expect(row?.items).toEqual(input().items);
		expect(row?.createdAt.getTime()).toBe(1_000);
	});

	test("the newest record wins, so a later failure revokes an earlier pass", async () => {
		await recordAttestation(
			handle.db,
			input({ runId: "run-2", createdAt: new Date(1_000) }),
		);
		await recordAttestation(
			handle.db,
			input({ runId: "run-2", outcome: "fail", createdAt: new Date(2_000) }),
		);
		expect((await latestAttestation(handle.db, "run-2"))?.outcome).toBe("fail");
	});

	test("records with one timestamp resolve to the last one written", async () => {
		const at = new Date(5_000);
		await recordAttestation(
			handle.db,
			input({ runId: "run-3", createdAt: at }),
		);
		await recordAttestation(
			handle.db,
			input({ runId: "run-3", outcome: "fail", createdAt: at }),
		);
		expect((await latestAttestation(handle.db, "run-3"))?.outcome).toBe("fail");
	});

	test("a failure written after a clock step back still revokes the pass", async () => {
		await recordAttestation(
			handle.db,
			input({ runId: "run-clock", createdAt: new Date(600_000) }),
		);
		await recordAttestation(
			handle.db,
			input({
				runId: "run-clock",
				outcome: "fail",
				createdAt: new Date(300_000),
			}),
		);
		expect((await latestAttestation(handle.db, "run-clock"))?.outcome).toBe(
			"fail",
		);
	});

	test("a run with no record has no attestation", async () => {
		expect(await latestAttestation(handle.db, "missing")).toBeNull();
	});

	describe("append-only", () => {
		test("an update is refused and changes nothing", async () => {
			await recordAttestation(
				handle.db,
				input({ runId: "run-update", outcome: "fail" }),
			);
			expect(
				await refused(
					handle.db
						.update(sandboxAttestations)
						.set({ outcome: "pass" })
						.where(eq(sandboxAttestations.runId, "run-update")),
				),
			).toBe(true);
			expect((await latestAttestation(handle.db, "run-update"))?.outcome).toBe(
				"fail",
			);
		});

		test("a delete cannot restore an older pass", async () => {
			await recordAttestation(handle.db, input({ runId: "run-delete" }));
			const failed = await recordAttestation(
				handle.db,
				input({ runId: "run-delete", outcome: "fail" }),
			);
			expect(
				await refused(
					handle.db
						.delete(sandboxAttestations)
						.where(eq(sandboxAttestations.id, failed)),
				),
			).toBe(true);
			expect((await latestAttestation(handle.db, "run-delete"))?.outcome).toBe(
				"fail",
			);
		});

		test("INSERT OR REPLACE cannot rewrite a row", async () => {
			const id = await recordAttestation(
				handle.db,
				input({ runId: "run-replace", outcome: "fail" }),
			);
			expect(
				await refused(
					handle.db.run(
						sql`INSERT OR REPLACE INTO sandbox_attestations
						(id, run_id, version, profile_hash, options_hash, seccomp_hash,
						 bwrap_version, scope, outcome, items, created_at)
						SELECT id, run_id, version, profile_hash, options_hash, seccomp_hash,
						 bwrap_version, scope, 'pass', items, created_at
						FROM sandbox_attestations WHERE id = ${id}`,
					),
				),
			).toBe(true);
			expect((await latestAttestation(handle.db, "run-replace"))?.outcome).toBe(
				"fail",
			);
		});
	});

	test("a malformed stored row reads as no attestation, never as a pass", async () => {
		await handle.db.insert(sandboxAttestations).values({
			id: "bad-row",
			runId: "run-4",
			version: ATTESTATION_VERSION,
			profileHash: "p",
			optionsHash: "o",
			seccompHash: "s",
			bwrapVersion: "0.13.1",
			scope: "systemd",
			outcome: "pass",
			items: "not-a-list" as never,
			createdAt: new Date(1_000),
		});
		expect(await latestAttestation(handle.db, "run-4")).toBeNull();
	});
});
