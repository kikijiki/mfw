import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocSourceConfig } from "@mfw/daemon/config";
import { defaultBoardYaml } from "@mfw/daemon/default-board-config";
import { DocsService } from "@mfw/daemon/docs";
import { silentLogger } from "@mfw/daemon/log";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "mfw-api-docs-"));
	const outside = await mkdtemp(join(tmpdir(), "mfw-api-docs-out-"));
	dirs.push(root, outside);
	await writeFile(join(root, "board.yaml"), defaultBoardYaml("DOC"));
	await mkdir(join(root, "adrs"));
	await writeFile(
		join(root, "adrs", "DOC-ADR-1-first.md"),
		"---\nmfw: 1\nid: DOC-ADR-1\ntitle: First\nstatus: accepted\n---\nBody about pelicans.\n",
	);
	await mkdir(join(root, "docs"));
	await writeFile(join(root, "docs", "a.md"), "# A page\npelican facts\n");
	await writeFile(join(outside, "x.md"), "# secret\n");
	await symlink(outside, join(root, "docs", "out"));

	let configured: DocSourceConfig[] = [];
	const started: unknown[] = [];
	const docs = new DocsService({
		repoRoot: root,
		boardDir: root,
		stateDir: join(root, ".mfw"),
		taskKey: "DOC",
		log: silentLogger(),
		configured: async () => configured,
		save: async (next) => {
			configured = next;
		},
	});
	const svc = {
		name: "demo",
		root,
		boardDir: root,
		docs,
		engine: {
			startImport: async (o: unknown) => {
				started.push(o);
				return { runId: "run-1" };
			},
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return {
		api: createCaller({ orchestrator }),
		configured: () => configured,
		started,
	};
}

describe("docs router", () => {
	test("sources, entries, read and search have the documented shape", async () => {
		const { api } = await fixture();
		const adopted = await api.docs.adopt({ project: "demo", ids: ["docs"] });
		expect(adopted.map((s) => s.id)).toEqual(["docs"]);

		const sources = await api.docs.sources({ project: "demo" });
		expect(sources.map((s) => `${s.kind}:${s.id}`)).toEqual([
			"board:adr",
			"dir:docs",
		]);

		const adrs = await api.docs.entries({ project: "demo", sourceId: "adr" });
		expect(adrs.entries[0]).toMatchObject({
			key: "DOC-ADR-1",
			title: "First",
			status: "accepted",
		});

		const page = await api.docs.read({
			project: "demo",
			sourceId: "docs",
			key: "a.md",
		});
		expect(page.entry.title).toBe("A page");
		expect(page.body).toContain("pelican facts");

		const hits = await api.docs.search({ project: "demo", q: "pelican" });
		expect(hits.map((h) => h.key).sort()).toEqual(["DOC-ADR-1", "a.md"]);
	});

	test("an unknown source is NOT_FOUND and a symlink out of the tree is FORBIDDEN", async () => {
		const { api } = await fixture();
		await api.docs.adopt({ project: "demo", ids: ["docs"] });
		await expect(
			api.docs.entries({ project: "demo", sourceId: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			api.docs.read({ project: "demo", sourceId: "docs", key: "out/x.md" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("suggestions are only listed; startImport records the chosen ones", async () => {
		const { api, configured, started } = await fixture();
		const suggestions = await api.docs.suggestions({ project: "demo" });
		expect(suggestions.map((s) => s.id)).toEqual(["docs"]);
		expect(configured()).toEqual([]);

		const result = await api.runs.startImport({
			project: "demo",
			docSources: ["docs"],
		});
		expect(result.runId).toBe("run-1");
		expect(result.docSources.map((d) => d.id)).toEqual(["docs"]);
		expect(configured().map((c) => c.id)).toEqual(["docs"]);
		expect(started).toHaveLength(1);

		// Without a selection nothing is recorded.
		const plain = await fixture();
		const none = await plain.api.runs.startImport({ project: "demo" });
		expect(none.docSources).toEqual([]);
		expect(plain.configured()).toEqual([]);
	});
});
