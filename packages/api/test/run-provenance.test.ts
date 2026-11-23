import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRegistry } from "@mfw/daemon/run-registry";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { createCaller } from "../src/root.ts";

const open: { h: ProjectDbHandle; dir: string }[] = [];
afterEach(async () => {
	for (const { h, dir } of open.splice(0)) {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-api-provenance-"));
	const handle = await openProjectDb(dir);
	open.push({ h: handle, dir });
	const registry = new RunRegistry({
		handle,
		bus: new EventBus(),
		runsDir: join(dir, "runs"),
	});
	const svc = {
		name: "demo",
		handle,
		registry,
		tasks: { titles: () => new Map() },
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	const run = await registry.create({
		kind: "task",
		label: "l",
		model: "m",
		cwd: dir,
	});
	await registry.transition(run.id, "running");
	return { registry, id: run.id, api: createCaller({ orchestrator }) };
}

describe("runs.get provenance", () => {
	test("a forged exit stays a claim beside the host's observation", async () => {
		const { registry, id, api } = await fixture();
		await registry.recordExit(id, {
			exitCode: 3,
			outcome: "completed",
			evidence: { provenance: "host-observed", source: "host-exit-record" },
		});
		await registry.recordAgentExitClaim(id, { kind: "exit", code: 0 });
		await registry.recordReportFact(id, { status: "success" });

		const run = await api.runs.get({ project: "demo", runId: id });
		expect(run?.exitCode).toBe(3);
		expect(run?.provenance.exit).toEqual({
			observed: { kind: "exit", code: 3 },
			agentSays: { kind: "exit", code: 0 },
			disagree: true,
		});
		expect(run?.provenance.reportStatus).toBe("success");
	});

	test("an exit the host did not observe is never returned as observed", async () => {
		const { registry, id, api } = await fixture();
		await registry.recordExit(id, { exitCode: 0, outcome: "completed" });
		const run = await api.runs.get({ project: "demo", runId: id });
		expect(run?.provenance.exit.observed).toBeNull();
		expect(run?.provenance.exit.agentSays).toEqual({ kind: "exit", code: 0 });
	});

	test("a malformed report status is not echoed", async () => {
		const { registry, id, api } = await fixture();
		await registry.recordReportFact(id, { status: "<b>done</b>" });
		const run = await api.runs.get({ project: "demo", runId: id });
		expect(run?.provenance.reportStatus).toBeNull();
	});
});
