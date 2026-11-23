import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { recordRunFact } from "../src/run-facts.ts";

let dir: string;
let handle: ProjectDbHandle;

afterEach(() => {
	handle?.close();
	rmSync(dir, { recursive: true, force: true });
});

async function open() {
	dir = mkdtempSync(join(tmpdir(), "mfw-facts-import-"));
	handle = await openProjectDb(dir);
}

const row = (fact: string, provenance: string) => sql`
	INSERT INTO run_facts (run_id, fact, provenance, value, source, first_observed_at, observed_at)
	VALUES ('r1', ${fact}, ${provenance}, '{}', 'finalize', 1, 1)`;

describe("the result import facts", () => {
	test("the import is host-observed and the helper's claim sandbox-reported", async () => {
		await open();
		await recordRunFact(handle.db, {
			runId: "r1",
			fact: "result_import",
			provenance: "host-observed",
			value: { outcome: "imported" },
			source: "host-git-import",
		});
		await recordRunFact(handle.db, {
			runId: "r1",
			fact: "wip_claim",
			provenance: "sandbox-reported",
			value: { ok: true },
			source: "outbox-wip-ack",
		});
		await expect(
			recordRunFact(handle.db, {
				runId: "r1",
				fact: "result_import",
				provenance: "sandbox-reported",
				value: {},
				source: "outbox-wip-ack",
			} as never),
		).rejects.toThrow("cannot be");
	});

	test("the database itself refuses a claim recorded as an observation", async () => {
		await open();
		const insert = async (fact: string, provenance: string) => {
			await handle.db.run(row(fact, provenance));
		};
		await expect(insert("wip_claim", "host-observed")).rejects.toThrow();
		await expect(insert("result_import", "sandbox-reported")).rejects.toThrow();
	});

	test("the migration keeps existing rows", async () => {
		await open();
		await handle.db.run(row("report", "sandbox-reported"));
		const text = readFileSync(
			join(import.meta.dir, "../migrations/0024_run_result_import.sql"),
			"utf8",
		);
		for (const statement of text.split("--> statement-breakpoint")) {
			await handle.db.run(sql.raw(statement));
		}
		const rows = await handle.db.all(sql`SELECT fact FROM run_facts`);
		expect(rows).toEqual([{ fact: "report" }]);
	});
});
