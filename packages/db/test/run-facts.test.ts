import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	migrationsDir,
	openProjectDb,
	type ProjectDbHandle,
} from "../src/client.ts";
import {
	FACT_PROVENANCE,
	RUN_FACT_KINDS,
	RUN_FACT_PROVENANCE,
	type RunFactTag,
	runFactsPairCheck,
} from "../src/provenance.ts";
import {
	foldRunExit,
	listRunFacts,
	RUN_FACT_MAX_BYTES,
	recordRunFact,
} from "../src/run-facts.ts";

const open: { h: ProjectDbHandle; dir: string }[] = [];
async function db(): Promise<ProjectDbHandle> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-run-facts-"));
	const h = await openProjectDb(dir);
	open.push({ h, dir });
	return h;
}
afterEach(async () => {
	for (const { h, dir } of open.splice(0)) {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
});

const insertRaw = (h: ProjectDbHandle, fact: string, provenance: string) =>
	h.client.execute({
		sql: `INSERT INTO run_facts (run_id, fact, provenance, value, source, first_observed_at, observed_at)
		      VALUES ('r', ?, ?, 'null', 'finalize', 1, 1)`,
		args: [fact, provenance],
	});

describe("run_facts store", () => {
	test("the provenance enum is exactly the two tags", () => {
		expect([...FACT_PROVENANCE]).toEqual(["host-observed", "sandbox-reported"]);
	});

	test("the database refuses a tag outside the enum", async () => {
		const h = await db();
		await expect(insertRaw(h, "exit", "trusted")).rejects.toThrow();
		await expect(insertRaw(h, "exit", "")).rejects.toThrow();
	});

	test("the database refuses an unknown fact", async () => {
		const h = await db();
		await expect(insertRaw(h, "made_up", "host-observed")).rejects.toThrow();
	});

	test("the database refuses every agent-only fact tagged host-observed", async () => {
		const h = await db();
		const agentOnly = RUN_FACT_KINDS.filter(
			(k) =>
				!(RUN_FACT_PROVENANCE[k] as readonly string[]).includes(
					"host-observed",
				),
		);
		expect(agentOnly).toContain("agent_exit_claim");
		expect(agentOnly).toContain("report");
		for (const fact of agentOnly) {
			await expect(insertRaw(h, fact, "host-observed")).rejects.toThrow();
		}
	});

	test("the writer refuses a mis-tagged fact even past the type system", async () => {
		const h = await db();
		const forged = {
			fact: "report",
			provenance: "host-observed",
		} as unknown as RunFactTag;
		await expect(
			recordRunFact(h.db, {
				...forged,
				runId: "r",
				value: {},
				source: "report-file",
			}),
		).rejects.toThrow(/cannot be host-observed/);
		expect(await listRunFacts(h.db, "r")).toEqual([]);
	});

	test("a host observation and an agent claim are kept side by side", async () => {
		const h = await db();
		await recordRunFact(h.db, {
			runId: "r",
			fact: "exit",
			provenance: "host-observed",
			value: { kind: "exit", code: 3 },
			source: "host-exit-record",
		});
		await recordRunFact(h.db, {
			runId: "r",
			fact: "agent_exit_claim",
			provenance: "sandbox-reported",
			value: { kind: "exit", code: 0 },
			source: "outbox-exit",
		});
		expect(foldRunExit(await listRunFacts(h.db, "r"))).toEqual({
			observed: { kind: "exit", code: 3 },
			agentSays: { kind: "exit", code: 0 },
			disagree: true,
		});
	});

	test("a sandbox-reported exit never folds into observed", async () => {
		const h = await db();
		await recordRunFact(h.db, {
			runId: "r",
			fact: "exit",
			provenance: "sandbox-reported",
			value: { kind: "exit", code: 0 },
			source: "flat-exit",
		});
		const fold = foldRunExit(await listRunFacts(h.db, "r"));
		expect(fold.observed).toBeNull();
		expect(fold.agentSays).toEqual({ kind: "exit", code: 0 });
	});

	test("a host-observed exit is write-once", async () => {
		const h = await db();
		for (const code of [3, 0]) {
			await recordRunFact(h.db, {
				runId: "r",
				fact: "exit",
				provenance: "host-observed",
				value: { kind: "exit", code },
				source: "host-exit-record",
			});
		}
		expect(foldRunExit(await listRunFacts(h.db, "r")).observed).toEqual({
			kind: "exit",
			code: 3,
		});
	});

	test("other facts keep the latest value in one row", async () => {
		const h = await db();
		for (const n of [1, 2, 3]) {
			await recordRunFact(h.db, {
				runId: "r",
				fact: "usage_live",
				provenance: "sandbox-reported",
				value: { n },
				source: "transcript",
			});
		}
		const rows = await listRunFacts(h.db, "r", "usage_live");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toEqual({ n: 3 });
	});

	test("an oversized agent value is replaced by a marker", async () => {
		const h = await db();
		await recordRunFact(h.db, {
			runId: "r",
			fact: "report",
			provenance: "sandbox-reported",
			value: { text: "x".repeat(RUN_FACT_MAX_BYTES * 2) },
			source: "report-file",
		});
		const [row] = await listRunFacts(h.db, "r", "report");
		expect((row?.value as { truncated: boolean }).truncated).toBe(true);
	});

	test("a malformed exit value folds to nothing", () => {
		const fold = foldRunExit([
			{
				fact: "exit",
				provenance: "host-observed",
				value: { kind: "exit", code: "0" },
				source: "finalize",
				observedAt: 1,
			},
		]);
		expect(fold.observed).toBeNull();
	});
});

describe("the baseline migration", () => {
	const meta = join(migrationsDir(), "meta");
	const journal = JSON.parse(
		readFileSync(join(meta, "_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string }[] };

	test("is the only journaled migration, and its snapshot holds the code's CHECK", () => {
		expect(journal.entries.map((e) => e.tag)).toEqual(["0000_baseline"]);
		const snap = JSON.parse(
			readFileSync(join(meta, "0000_snapshot.json"), "utf8"),
		) as {
			tables: Record<
				string,
				{ checkConstraints: Record<string, { value: string }> }
			>;
		};
		expect(
			snap.tables.run_facts?.checkConstraints.ck_run_facts_pair?.value,
		).toBe(runFactsPairCheck());
	});

	test("its CHECK is the one the code derives", () => {
		const text = readFileSync(
			join(migrationsDir(), "0000_baseline.sql"),
			"utf8",
		);
		expect(text).toContain(runFactsPairCheck());
	});

	test("a fresh database gets the table and the marker column", async () => {
		const h = await db();
		const columns = await h.client.execute("PRAGMA table_info(runs)");
		expect(columns.rows.some((r) => r.name === "run_dir_layout")).toBe(true);
		const tables = await h.client.execute(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='run_facts'",
		);
		expect(tables.rows).toHaveLength(1);
	});
});
