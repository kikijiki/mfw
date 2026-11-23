import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { guardWithRecords } from "../src/claims-evidence.ts";
import {
	auditProbeRecorder,
	parseProbeRecording,
	probeAndRecord,
} from "../src/deployment-probe.ts";
import { runDeploymentSmoke } from "../src/deployment-smoke.ts";

const open: { h: ProjectDbHandle; dir: string }[] = [];
afterEach(async () => {
	for (const { h, dir } of open.splice(0)) {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
});

async function db(): Promise<ProjectDbHandle> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-probe-"));
	const h = await openProjectDb(dir);
	open.push({ h, dir });
	return h;
}

const brain = { author: "brain" } as const;
const marked = async (h: ProjectDbHandle, text: string) =>
	(await guardWithRecords(h.db, text, brain)).changed;

describe("deployment.probed producer", () => {
	test("a passing host smoke backs deployed, and only deployed", async () => {
		const h = await db();
		const now = 1_700_000_000_000;
		await runDeploymentSmoke(
			{ target: "prod", record: auditProbeRecorder(h, () => now) },
			async () => {},
		);
		expect(await marked(h, "prod is deployed.")).toBe(false);
		// the smoke is a deploy probe: it says nothing about health
		expect(await marked(h, "prod is healthy.")).toBe(true);
		const [row] = await h.db.query.events.findMany();
		expect(row?.type).toBe("deployment.probed");
		expect(row?.ts.getTime()).toBe(now);
		expect(row?.payload).toEqual({ target: "prod", probe: "deploy", ok: true });
	});

	test("a health probe backs healthy for its target only", async () => {
		const h = await db();
		await probeAndRecord(
			{
				target: "prod",
				probe: "health",
				record: auditProbeRecorder(h),
			},
			async () => "up",
		);
		expect(await marked(h, "prod is healthy.")).toBe(false);
		expect(await marked(h, "staging is healthy.")).toBe(true);
		expect(await marked(h, "prod is deployed.")).toBe(true);
	});

	test("an agent-reported claim leaves deployed and healthy weak", async () => {
		const h = await db();
		expect(await marked(h, "prod is deployed.")).toBe(true);
		expect(await marked(h, "prod is healthy.")).toBe(true);
		const agent = await guardWithRecords(h.db, "prod is deployed.", {
			author: "agent",
		});
		expect(agent.changed).toBe(true);
	});

	test("a failed probe records the failure, rethrows, and backs nothing", async () => {
		const h = await db();
		const failing = runDeploymentSmoke(
			{ target: "prod", record: auditProbeRecorder(h) },
			async () => {
				throw new Error("route /mfw/resources returned 502\nlog tail line");
			},
		);
		await expect(failing).rejects.toThrow("returned 502");
		expect(await marked(h, "prod is deployed.")).toBe(true);
		expect(await marked(h, "prod is healthy.")).toBe(true);
		const [row] = await h.db.query.events.findMany();
		expect(row?.payload).toEqual({
			target: "prod",
			probe: "deploy",
			ok: false,
			detail: "route /mfw/resources returned 502",
		});
	});

	test("a later failed probe withdraws an earlier pass", async () => {
		const h = await db();
		const record = auditProbeRecorder(h);
		await probeAndRecord(
			{ target: "prod", probe: "deploy", record },
			async () => {},
		);
		await probeAndRecord(
			{ target: "prod", probe: "deploy", record },
			async () => {
				throw new Error("down");
			},
		).catch(() => {});
		expect(await marked(h, "prod is deployed.")).toBe(true);
	});

	test("a record failure after a passing run is loud, never a silent pass", async () => {
		const failingRecord = async () => {
			throw new Error("db down");
		};
		await expect(
			probeAndRecord(
				{ target: "prod", probe: "deploy", record: failingRecord },
				async () => {},
			),
		).rejects.toThrow("db down");
	});

	test("the real smoke refuses without its gate and records that as a failure", async () => {
		const h = await db();
		await expect(
			runDeploymentSmoke({ target: "prod", record: auditProbeRecorder(h) }),
		).rejects.toThrow("--runpod-disabled");
		expect(await marked(h, "prod is deployed.")).toBe(true);
		const [row] = await h.db.query.events.findMany();
		expect(row?.payload).toMatchObject({ ok: false, probe: "deploy" });
	});

	test("recording is opt-in and needs both flags", () => {
		expect(parseProbeRecording(["bun", "x.ts"])).toBeNull();
		expect(
			parseProbeRecording(["--record-to", "/d", "--target", "prod"]),
		).toEqual({ mfwDir: "/d", target: "prod" });
		expect(() => parseProbeRecording(["--target", "prod"])).toThrow();
		expect(() => parseProbeRecording(["--record-to", "--target"])).toThrow();
	});
});
