import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { sandboxAttestations } from "@mfw/db/schema";
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
