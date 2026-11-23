import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { listRunFacts } from "@mfw/db/run-facts";
import { runs } from "@mfw/db/schema";
import { getTableColumns } from "drizzle-orm";
import { RunRegistry } from "../src/run-registry.ts";

/**
 * Proves no L1 fact reaches the database untagged. Three layers: every `runs`
 * column is classified, a source scan finds every writer, and each writer is
 * run to show the tagged row it leaves.
 */

/** Columns holding a fact about what a run did. Each must be written with a tag. */
const L1_COLUMNS = [
	"outcome",
	"capabilities",
	"exitCode",
	"killReason",
	"usage",
	"usageLive",
	"scopeSample",
	"activity",
	"activityDetail",
	"nativeSessionId",
	"transcriptSummary",
] as const;

/** Set by the host from its own config or lifecycle; not an observation of the run. */
const NOT_FACTS = [
	"id",
	"kind",
	"taskId",
	"parentRunId",
	"label",
	"model",
	"providerId",
	"reasoningEffort",
	"cwd",
	"worktreePath",
	"branch",
	"integrationBranch",
	"baseSha",
	"attempt",
	"resumeOrdinal",
	"maxRepairs",
	"argv",
	"initialPrompt",
	"goal",
	"executionTarget",
	"targetProjectId",
	"targetLeaseRef",
	"targetExecutionPath",
	"targetRequestedShape",
	"targetObservedShape",
	"workloadSecretGrantIds",
	"workloadSecretNames",
	"workloadSecretBinding",
	"targetLifecycleState",
	"targetCleanupRequestedAt",
	"targetAbsenceConfirmedAt",
	"state",
	"finalizeOwner",
	"finalizeClaimedAt",
	"note",
	"startedAt",
	"finishedAt",
	"harness",
	"modelVendor",
	"routing",
	"taskSize",
	"taskType",
	"modelTier",
	"hostId",
	"relation",
	"chainRootId",
	"spawnedByDecisionId",
	"originRef",
	"groupId",
	"role",
	"runDirLayout",
	"workspaceKind",
];

const REPO = resolve(import.meta.dir, "../../..");
const REGISTRY = "packages/daemon/src/run-registry.ts";

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (name === "node_modules" || name === "dist" || name === "test") {
			return [];
		}
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** The text of a call's arguments, from the `(` at `open`. */
function callText(text: string, open: number): string {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
	}
	return text.slice(open);
}

const L1_KEY = new RegExp(`\\b(${L1_COLUMNS.join("|")})\\b\\s*[:,}]`);
const EXIT_KEY = /\b(outcome|exitCode|killReason)\b\s*[:,}]/;

/** Every way the given source writes an L1 fact without its tag. */
function untaggedWriters(file: string, text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/\.update\(runs\)/g)) {
		const rest = text.slice(m.index);
		const end = rest.search(/\.where\(|;\n/);
		const block = rest.slice(0, end < 0 ? undefined : end);
		if (!L1_KEY.test(block) && !block.includes("...fields")) continue;
		if (file !== REGISTRY) {
			out.push(`${file}: writes an L1 column of runs outside the registry`);
			continue;
		}
		const before = text.lastIndexOf("\n\tasync ", m.index);
		const after = text.indexOf("\n\tasync ", m.index);
		const method = text.slice(before, after < 0 ? undefined : after);
		if (!/recordRunFact\(|recordTransitionFacts\(/.test(method)) {
			out.push(`${file}: a registry method writes an L1 column with no fact`);
		}
	}
	if (/\b(UPDATE|INSERT INTO)\s+[`"]?runs\b/.test(text)) {
		out.push(`${file}: raw SQL writes runs`);
	}
	if (
		/\.insert\(runFacts\)/.test(text) &&
		file !== "packages/db/src/run-facts.ts"
	) {
		out.push(`${file}: writes run_facts directly`);
	}
	if (
		/\.insert\(runSubagents\)/.test(text) &&
		file !== "packages/daemon/src/run-subagents.ts"
	) {
		out.push(`${file}: writes run_subagents directly`);
	}
	if (file !== REGISTRY) {
		for (const m of text.matchAll(/\.recordExit\(/g)) {
			const call = callText(text, (m.index as number) + ".recordExit".length);
			if (!/\bevidence\b/.test(call)) {
				out.push(`${file}: recordExit without evidence`);
			}
		}
		for (const m of text.matchAll(/registry\.transition\(/g)) {
			const call = callText(
				text,
				(m.index as number) + "registry.transition".length,
			);
			if (EXIT_KEY.test(call) && !/\bevidence\b/.test(call)) {
				out.push(`${file}: transition sets an exit fact without evidence`);
			}
		}
	}
	return out;
}

describe("no untagged L1 writer exists", () => {
	test("every runs column is classified as a fact or not", () => {
		const columns = Object.keys(getTableColumns(runs)).sort();
		expect(columns).toEqual([...L1_COLUMNS, ...NOT_FACTS].sort());
	});

	test("the source holds no untagged writer", () => {
		const files = ["packages", "apps"].flatMap((d) => sources(join(REPO, d)));
		expect(files.length).toBeGreaterThan(200);
		const found = files.flatMap((path) =>
			untaggedWriters(relative(REPO, path), readFileSync(path, "utf8")),
		);
		expect(found).toEqual([]);
	});

	describe("the scanner catches a new writer", () => {
		const cases: [string, string, string][] = [
			[
				"a column written outside the registry",
				"packages/daemon/src/new.ts",
				"await db.update(runs).set({ exitCode: 0 }).where(x);",
			],
			[
				"a registry method with no fact",
				REGISTRY,
				"\n\tasync forge() {\n\t\tawait db.update(runs).set({ usage: u }).where(x);\n\t}\n",
			],
			[
				"raw SQL",
				"packages/daemon/src/new.ts",
				'await c.execute("UPDATE runs SET exit_code = 0");',
			],
			[
				"a direct insert into run_facts",
				"packages/daemon/src/new.ts",
				"await tx.insert(runFacts).values(row);",
			],
			[
				"recordExit without evidence",
				"packages/daemon/src/new.ts",
				'await r.recordExit(id, { outcome: "completed" });',
			],
			[
				"a transition setting an exit without evidence",
				"packages/daemon/src/new.ts",
				'await this.deps.registry.transition(id, "ended", { exitCode: 0 });',
			],
		];
		for (const [name, file, text] of cases) {
			test(name, () => {
				expect(untaggedWriters(file, text).length).toBeGreaterThan(0);
			});
		}

		test("and accepts a tagged one", () => {
			expect(
				untaggedWriters(
					"packages/daemon/src/new.ts",
					'await r.recordExit(id, { outcome: "interrupted", evidence: e });',
				),
			).toEqual([]);
		});
	});
});

describe("each registry writer leaves a tagged row", () => {
	const open: { h: ProjectDbHandle; dir: string }[] = [];
	afterEach(async () => {
		for (const { h, dir } of open.splice(0)) {
			h.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function fixture() {
		const dir = await mkdtemp(join(tmpdir(), "mfw-fact-writers-"));
		const h = await openProjectDb(dir);
		open.push({ h, dir });
		const registry = new RunRegistry({
			handle: h,
			bus: new EventBus(),
			runsDir: join(dir, "runs"),
		});
		const run = await registry.create({
			kind: "task",
			label: "l",
			model: "m",
			cwd: dir,
		});
		await registry.transition(run.id, "running");
		const tag = async (fact: Parameters<typeof listRunFacts>[2]) =>
			(await listRunFacts(h.db, run.id, fact)).map((f) => f.provenance);
		return { registry, id: run.id, tag };
	}

	const REPORTED = ["sandbox-reported" as const];

	test("capabilities from the driver", async () => {
		const { registry, id, tag } = await fixture();
		await registry.setCapabilities(id, { steer: true, verified: true });
		expect(await tag("capabilities")).toEqual(REPORTED);
	});

	test("activity", async () => {
		const { registry, id, tag } = await fixture();
		await registry.setActivity(id, "working", {
			pendingApprovals: [],
		} as never);
		expect(await tag("activity")).toEqual(REPORTED);
	});

	test("the scope sample is the host's", async () => {
		const { registry, id, tag } = await fixture();
		await registry.setScopeSample(id, {
			level: "ok",
			files: 1,
			outside: 0,
			foreign: 0,
		});
		expect(await tag("scope")).toEqual(["host-observed"]);
	});

	test("live usage", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordUsageSample(id, { tokensIn: 1, tokensOut: 2 });
		expect(await tag("usage_live")).toEqual(REPORTED);
	});

	test("final usage", async () => {
		const { registry, id, tag } = await fixture();
		await registry.transition(id, "running", { usage: { inputTokens: 1 } });
		expect(await tag("usage")).toEqual(REPORTED);
	});

	test("subagents", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordSubagents(id, []);
		expect(await tag("subagents")).toEqual(REPORTED);
	});

	test("the native session", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordNativeSession(id, "session-1");
		expect(await tag("native_session")).toEqual(REPORTED);
	});

	test("the transcript summary", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordTranscriptSummary(id, { prunedAt: 1 });
		expect(await tag("transcript_summary")).toEqual(REPORTED);
	});

	test("the report and the exit claim", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordReportFact(id, { status: "success" });
		await registry.recordAgentExitClaim(id, { kind: "exit", code: 0 });
		expect(await tag("report")).toEqual(REPORTED);
		expect(await tag("agent_exit_claim")).toEqual(REPORTED);
	});

	test("an exit with evidence carries that evidence", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordExit(id, {
			exitCode: 3,
			outcome: "completed",
			evidence: { provenance: "host-observed", source: "host-exit-record" },
		});
		expect(await tag("exit")).toEqual(["host-observed"]);
		expect(await tag("outcome")).toEqual(["host-observed"]);
	});

	test("an exit without evidence is never host-observed", async () => {
		const { registry, id, tag } = await fixture();
		await registry.recordExit(id, { exitCode: 0, outcome: "completed" });
		expect(await tag("exit")).toEqual(REPORTED);
		expect(await tag("outcome")).toEqual(REPORTED);
	});
});
