import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { appendEvent } from "@mfw/db/eventlog";
import { recordRunFact } from "@mfw/db/run-facts";
import { type DigestInput, renderDigest } from "../src/brain-runtime/digest.ts";
import { CLAIM_INSTRUCTION } from "../src/claims.ts";
import {
	guardBrainRows,
	guardDecisionRows,
	guardWithRecords,
	hostClaimsForRun,
	loadHostEvidence,
} from "../src/claims-evidence.ts";
import { buildHeadline } from "../src/headlines.ts";
import { runProvenanceView } from "../src/run-provenance-view.ts";

const open: { h: ProjectDbHandle; dir: string }[] = [];
afterEach(async () => {
	for (const { h, dir } of open.splice(0)) {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
});

async function db(): Promise<ProjectDbHandle> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-claims-"));
	const h = await openProjectDb(dir);
	open.push({ h, dir });
	return h;
}

const verifyCheck = (h: ProjectDbHandle, passed: boolean) =>
	h.withTx((tx) =>
		appendEvent(tx, {
			type: "verify.check",
			taskId: "MFW-1",
			runId: "run-1",
			payload: { check: "test", passed },
		}),
	);
const merged = (h: ProjectDbHandle) =>
	h.withTx((tx) =>
		appendEvent(tx, {
			type: "merge.completed",
			taskId: "MFW-1",
			runId: "run-1",
			payload: { sha: "abc", target: "main" },
		}),
	);

const brain = { author: "brain" } as const;

describe("evidence from the event log", () => {
	test("brain text saying verified with no record is marked", async () => {
		const h = await db();
		const g = await guardWithRecords(h.db, "MFW-1 is verified.", brain);
		expect(g.text).toBe("MFW-1 is verified (brain's claim, no host record).");
		expect(g.original).toBe("MFW-1 is verified.");
	});

	test("a host verify.check backs the same sentence", async () => {
		const h = await db();
		await verifyCheck(h, true);
		const g = await guardWithRecords(h.db, "MFW-1 is verified.", brain);
		expect(g.changed).toBe(false);
	});

	test("a failed check does not", async () => {
		const h = await db();
		await verifyCheck(h, false);
		const g = await guardWithRecords(h.db, "MFW-1 is verified.", brain);
		expect(g.changed).toBe(true);
	});

	test("an agent's report claiming deployed and healthy backs nothing", async () => {
		const h = await db();
		await recordRunFact(h.db, {
			runId: "run-1",
			fact: "report",
			provenance: "sandbox-reported",
			value: { status: "deployed", healthy: true, verified: true },
			source: "report-file",
		});
		const g = await guardWithRecords(
			h.db,
			"run-1 is deployed and healthy and verified.",
			{ ...brain, subject: { kind: "run", id: "run-1" } },
		);
		expect(g.findings.map((f) => f.outcome)).toEqual([
			"annotated",
			"annotated",
			"annotated",
		]);
		expect(await hostClaimsForRun(h.db, "run-1")).toEqual([]);
		const view = await runProvenanceView(h.db, "run-1");
		expect(view.reportStatus).toBe("deployed");
		expect(view.claims).toEqual([]);
	});

	test("the run view lists only what the host saw", async () => {
		const h = await db();
		await verifyCheck(h, true);
		await merged(h);
		const words = (await hostClaimsForRun(h.db, "run-1")).map((c) => c.text);
		expect(words).toEqual(["verified", "merged", "fixed"]);
	});

	test("a host probe backs deployed for its target", async () => {
		const h = await db();
		await h.withTx((tx) =>
			appendEvent(tx, {
				type: "deployment.probed",
				payload: { target: "prod", probe: "deploy", ok: true },
			}),
		);
		expect(
			(await guardWithRecords(h.db, "prod is deployed.", brain)).changed,
		).toBe(false);
		expect(
			(await guardWithRecords(h.db, "prod is healthy.", brain)).changed,
		).toBe(true);
	});

	test("a failed evidence read marks everything", async () => {
		const h = await db();
		await verifyCheck(h, true);
		const broken = {
			select: () => {
				throw new Error("db down");
			},
		} as unknown as ProjectDbHandle["db"];
		const g = await guardWithRecords(broken, "MFW-1 is verified.", brain);
		expect(g.changed).toBe(true);
	});

	test("subjects past the lookup cap stay unbacked", async () => {
		const h = await db();
		await verifyCheck(h, true);
		const many = Array.from({ length: 80 }, (_, i) => `X-${i}`).join(" ");
		const e = await loadHostEvidence(h.db, [`${many} MFW-1`]);
		expect(e.backsId("verified", "MFW-1")).toBe(false);
	});

	test("rows read later are guarded, and untouched rows keep identity", async () => {
		const h = await db();
		await verifyCheck(h, true);
		const ok = { taskId: "MFW-1", reason: "It is verified." };
		const bad = { taskId: "MFW-2", reason: "It is verified." };
		const none = { taskId: null, reason: null };
		const out = await guardBrainRows(h.db, [ok, bad, none], "reason");
		expect(out[0]).toBe(ok);
		expect(out[1]?.reason).toContain("no host record");
		expect(bad.reason).toBe("It is verified.");
		expect(out[2]).toBe(none);
	});
});

describe("decision rows as shown", () => {
	const row = (over: Record<string, unknown>) => ({
		role: "brain",
		kind: "action",
		action: "spawn",
		taskId: "MFW-2",
		reason: "It is fixed.",
		input: {},
		...over,
	});

	test("the owner's own words are never marked", async () => {
		const h = await db();
		const rows = [
			row({ role: "human" }),
			row({ kind: "override" }),
			row({ action: "brain.message" }),
		];
		const out = await guardDecisionRows(h.db, rows);
		for (const d of out) expect(d.reason).toBe("It is fixed.");
	});

	test("a critic's text is marked as an agent's", async () => {
		const h = await db();
		const [d] = await guardDecisionRows(h.db, [row({ role: "critic" })]);
		expect(d?.reason).toBe("It is fixed (agent says, no host record).");
	});

	test("a page's title and body are guarded in the view only", async () => {
		const h = await db();
		const input = {
			kind: "fyi",
			title: "It is healthy",
			body: "It is merged.",
		};
		const stored = row({ action: "notify_human", input });
		const [d] = await guardDecisionRows(h.db, [stored]);
		expect(d?.input).toEqual({
			kind: "fyi",
			title: "It is healthy (brain's claim, no host record)",
			body: "It is merged (brain's claim, no host record).",
		});
		expect(input.title).toBe("It is healthy");
	});
});

describe("headlines", () => {
	const line = (kind = "review") =>
		buildHeadline({
			project: "demo",
			landedToday: 2,
			inboxItems: [{ kind, attention: "act" } as never],
			budgets: [{ unit: "usd", fraction: 0.5 }],
			attention: { heldBack: 1, debt: { count: 1, oldestAgeMs: null } },
		});
	const classOf = (h: ReturnType<typeof line>, key: string) =>
		h.parts.find((p) => p.key === key)?.claimClass;

	test("every part carries a class and the sentence is unchanged", () => {
		const h = line();
		for (const p of h.parts) expect(p.claimClass).toBeDefined();
		expect(h.text).toStartWith("Landed 2, needs you 1; main green; spend 50%");
	});

	test("only a merge count and a red record are host-observed", () => {
		const h = line();
		expect(classOf(h, "landed")).toBe("host-observed");
		expect(classOf(h, "main")).toBe("inference");
		expect(classOf(h, "spend")).toBe("agent-reported");
		expect(classOf(line("main_red"), "main")).toBe("host-observed");
	});
});

describe("digest", () => {
	const base: DigestInput = {
		wakeClass: "human",
		turnSeq: 1,
		generation: 1,
		resumed: true,
		now: 1_800_000_000_000,
		lastTurnAt: null,
		events: [],
		eventsFrom: 1,
		eventsTo: 1,
		runFacts: [
			{
				runId: "r",
				kind: "agent",
				model: "m",
				state: "succeeded",
				verify: "passed",
				report: "deployed and healthy",
			},
		],
		applied: [],
		live: [],
		frontier: [],
		humanOpen: [],
		capacity: [],
		reminders: [],
	};

	test("a resumed session still gets the claim instruction", () => {
		expect(renderDigest(base).markdown).toContain(CLAIM_INSTRUCTION);
	});

	test("run lines carry their class", () => {
		const { markdown } = renderDigest(base);
		expect(markdown).toContain("verify [host-observed]: passed");
		expect(markdown).toContain("report [agent-reported]: deployed and healthy");
	});
});
