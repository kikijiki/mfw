import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { boot } from "../src/boot.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { RUNPOD_OWNERSHIP_ENV } from "../src/runpod-ownership.ts";
import {
	accountFixture,
	FakeRunPodProvider,
	reconcilePolicy,
	testIntent,
	untrackedPod,
} from "./fixtures/runpod-account.ts";

const homes: string[] = [];

afterEach(async () => {
	for (const home of homes.splice(0)) {
		await rm(home, { recursive: true, force: true });
	}
});

describe("process-global RunPod reconciliation", () => {
	test("an unhinted owned Pod is not attributed to the first unrelated unavailable project", async () => {
		const provider = new FakeRunPodProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-ambiguous-home-"));
		homes.push(home);
		provider.pods.push(
			untrackedPod("ambiguous-owned", "detached-run", "detached-project-id"),
		);

		const orchestrator = await boot({
			projects: [
				{ name: "unrelated-first", root: join(home, "missing-first") },
				{ name: "unrelated-second", root: join(home, "missing-second") },
			],
			mfwHome: home,
			log: silentLogger(),
			autostart: false,
			runpod: reconcilePolicy,
			runpodClient: provider,
		});

		expect(provider.deletes).toEqual([]);
		expect(provider.pods).toHaveLength(1);
		const gateReason = orchestrator.runpod.gate.status().reason ?? "";
		expect(gateReason).toContain("unresolved identity detached-project-id");
		expect(gateReason).not.toContain("unrelated-first");
		expect(gateReason).not.toContain("unrelated-second");
		const model = await orchestrator.runpod.readModel();
		expect(model.reconcile.lastError).toBe("owner_unavailable");
		expect(JSON.stringify(model.audit)).toContain(
			"retain_owned_pod_and_close_dispatch",
		);
		await orchestrator.shutdown();
	});

	test("boot retains a configured unavailable project's live owned Pod", async () => {
		const provider = new FakeRunPodProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-owner-home-"));
		const root = await mkdtemp(join(tmpdir(), "mfw-runpod-owner-project-"));
		homes.push(home, root);
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "runpod@test"], root);
		await git(["config", "user.name", "runpod-test"], root);
		await writeFile(join(root, "app.ts"), "export const live = true;\n");
		await git(["add", "-A"], root);
		await git(["commit", "-qm", "init"], root);

		const first = await boot({
			projects: [{ name: "configured-owner", root }],
			mfwHome: home,
			log: silentLogger(),
			autostart: false,
			runpod: reconcilePolicy,
			runpodClient: provider,
		});
		const ownerId = first.get("configured-owner").projectId;
		const lease = await first.runpod.putLeaseIntent(
			testIntent("survives-attach-failure", ownerId),
		);
		await first.runpod.command(lease.ref, "boot-regression/provision", {
			type: "provision",
		});
		provider.pods.push(
			untrackedPod(
				"owned-without-global-lease",
				"also-survives-attach-failure",
				ownerId,
			),
		);
		expect(provider.pods).toHaveLength(2);
		await first.shutdown();

		// Simulate an attachment/DB migration failure while durable project identity
		// and the machine-wide RunPod lease both survive the restart.
		const projectDb = join(root, ".mfw", "mfw.db");
		// A valid WAL can recover a damaged main file. Remove the sidecars so this
		// fixture reliably creates the migration failure it claims to exercise.
		await rm(`${projectDb}-wal`, { force: true });
		await rm(`${projectDb}-shm`, { force: true });
		await writeFile(projectDb, "not a sqlite database");
		const restarted = await boot({
			projects: [{ name: "configured-owner", root }],
			mfwHome: home,
			log: silentLogger(),
			autostart: false,
			runpod: reconcilePolicy,
			runpodClient: provider,
		});

		expect(restarted.projects.size).toBe(0);
		expect(provider.deletes).toEqual([]);
		expect(provider.pods).toHaveLength(2);
		expect(restarted.runpod.gate.status()).toMatchObject({
			open: false,
			reason: expect.stringContaining("configured but unavailable"),
		});
		const model = await restarted.runpod.readModel();
		expect(model.reconcile.lastError).toBe("owner_unavailable");
		expect(JSON.stringify(model.audit)).not.toContain("project_missing");
		await restarted.shutdown();
	});

	test("partial explicit detach cleanup is retried after restart to proven absence", async () => {
		const provider = new FakeRunPodProvider();
		const home = await mkdtemp(join(tmpdir(), "mfw-runpod-detach-home-"));
		const root = await mkdtemp(join(tmpdir(), "mfw-runpod-detach-project-"));
		homes.push(home, root);
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "runpod@test"], root);
		await git(["config", "user.name", "runpod-test"], root);
		await writeFile(join(root, "app.ts"), "export const live = true;\n");
		await git(["add", "-A"], root);
		await git(["commit", "-qm", "init"], root);

		const first = await boot({
			projects: [{ name: "detach-owner", root }],
			mfwHome: home,
			log: silentLogger(),
			autostart: false,
			runpod: reconcilePolicy,
			runpodClient: provider,
		});
		const projectId = first.get("detach-owner").projectId;
		const lease = await first.runpod.putLeaseIntent(
			testIntent("partial-detach", projectId),
		);
		await first.runpod.command(lease.ref, "partial-detach/provision", {
			type: "provision",
		});
		expect(provider.pods).toHaveLength(1);

		// The provider accepts deletes but continues reporting the exact owned Pod,
		// so detach commits config absence but cannot prove remote absence.
		provider.retainDeletes = true;
		await expect(first.detach("detach-owner")).rejects.toThrow(
			/detached with cleanup errors/,
		);
		expect(first.projects.size).toBe(0);
		expect(provider.pods).toHaveLength(1);
		const tombstoneDb = createClient({ url: `file:${first.runpod.dbPath}` });
		const tombstone = await tombstoneDb.execute({
			sql: "SELECT project_name FROM detached_projects WHERE project_id = ?",
			args: [projectId],
		});
		expect(tombstone.rows[0]?.project_name).toBe("detach-owner");
		tombstoneDb.close();
		await first.shutdown();

		provider.retainDeletes = false;
		const restarted = await boot({
			projects: [],
			mfwHome: home,
			log: silentLogger(),
			autostart: false,
			runpod: reconcilePolicy,
			runpodClient: provider,
		});

		expect(provider.pods).toHaveLength(0);
		expect(provider.deletes).toContain("created-1");
		expect(restarted.runpod.gate.status().open).toBe(true);
		const compactedDb = createClient({
			url: `file:${restarted.runpod.dbPath}`,
		});
		const compacted = await compactedDb.execute(
			"SELECT COUNT(*) AS count FROM detached_projects",
		);
		expect(Number(compacted.rows[0]?.count)).toBe(0);
		compactedDb.close();
		await restarted.shutdown();
	});

	test("Orchestrator starts one zero-project account reconciler even when project autostart is off", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		await fixture.account.stop();
		const orchestrator = await boot({
			projects: [],
			mfwHome: fixture.home,
			log: silentLogger(),
			autostart: false,
			runpod: reconcilePolicy,
			runpodClient: provider,
		});

		expect(provider.listCalls).toBeGreaterThan(0);
		expect(orchestrator.projects.size).toBe(0);
		expect(orchestrator.runpod.gate.status().open).toBe(true);
		await orchestrator.shutdown();
	});

	test("three leaked Pods, including an untracked Pod, converge across missing projects and restart", async () => {
		const provider = new FakeRunPodProvider();
		const first = await accountFixture(provider);
		homes.push(first.home);
		for (const [run, project] of [
			["run-attached", "detached-project"],
			["run-missing-db", "missing-db-project"],
		] as const) {
			const lease = await first.account.putLeaseIntent(
				testIntent(run, project),
			);
			await first.account.command(lease.ref, `${run}/provision`, {
				type: "provision",
			});
		}
		provider.pods.push(untrackedPod("untracked-3", "run-untracked"));
		await first.account.stop();

		const restarted = await accountFixture(provider, {
			mfwHome: first.home,
			resolveOwner: async () => ({
				state: "unrecoverable",
				projectName: null,
				reason: "project_missing",
			}),
		});
		await restarted.account.reconcile("startup");

		expect(provider.pods).toHaveLength(0);
		expect(new Set(provider.deletes)).toEqual(
			new Set(["created-1", "created-2", "untracked-3"]),
		);
		expect(restarted.account.gate.status().open).toBe(true);
		const calls = provider.deletes.length;
		await restarted.account.reconcile("idempotent-restart");
		expect(provider.deletes).toHaveLength(calls);
		await restarted.account.stop();
	});

	test("duplicate ownership is a critical incident and makes no provider mutation", async () => {
		const provider = new FakeRunPodProvider();
		const encoded = untrackedPod("one", "duplicate").env[
			RUNPOD_OWNERSHIP_ENV
		] as string;
		provider.pods = [
			untrackedPod("one", "duplicate", "missing-project", encoded),
			untrackedPod("two", "duplicate", "missing-project", encoded),
		];
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);

		await expect(fixture.account.reconcile("duplicate")).rejects.toMatchObject({
			code: "ambiguous_ownership",
		});
		expect(provider.deletes).toEqual([]);
		expect(provider.creates).toBe(0);
		expect(fixture.account.gate.status().open).toBe(false);
		const model = await fixture.account.readModel();
		expect(
			model.audit.some((entry) => entry.kind === "critical_safety_incident"),
		).toBe(true);
		expect(JSON.stringify(model)).not.toContain("must-never-be-persisted");
		await fixture.account.stop();
	});

	test("absence proof follows strong ownership, never only the original Pod id", async () => {
		const provider = new FakeRunPodProvider();
		const original = untrackedPod("original-id", "identity-survives");
		provider.pods = [original];
		provider.deletePod = async (podId: string) => {
			provider.deletes.push(podId);
			provider.pods = [
				untrackedPod(
					"replacement-id",
					"identity-survives",
					"missing-project",
					original.env[RUNPOD_OWNERSHIP_ENV],
				),
			];
		};
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);

		await expect(
			fixture.account.reconcile("identity-moved"),
		).rejects.toMatchObject({ code: "absence_not_confirmed" });
		expect(fixture.account.gate.status().open).toBe(false);
		expect((await fixture.account.readModel()).pods[0]).toMatchObject({
			podId: "replacement-id",
			ownership: "owned_untracked",
			cleanup: { pending: true },
		});
		await fixture.account.stop();
	});

	test("outage and malformed inventory fail closed without false absence or deletion", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods = [untrackedPod("still-burning", "outage")];
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		provider.listFailure = new Error("inventory outage");

		await expect(fixture.account.reconcile("outage")).rejects.toThrow(
			"inventory outage",
		);
		expect(provider.deletes).toEqual([]);
		expect(fixture.account.gate.status().open).toBe(false);

		provider.listFailure = null;
		provider.malformedInventory = [{ id: "bad", desiredStatus: "RUNNING" }];
		await expect(fixture.account.reconcile("malformed")).rejects.toMatchObject({
			code: "invalid_response",
		});
		expect(provider.deletes).toEqual([]);
		expect(provider.pods).toHaveLength(1);
		await fixture.account.stop();
	});

	test("cleanup stays pending with truthful burn and age until fresh absence proof", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods = [untrackedPod("retry-me", "cleanup-retry")];
		provider.retainDeletes = true;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);

		await expect(
			fixture.account.reconcile("first-cleanup"),
		).rejects.toMatchObject({ code: "absence_not_confirmed" });
		const pending = await fixture.account.readModel();
		expect(pending.reconcile.cleanupPending).toBe(1);
		expect(pending.pods[0]).toMatchObject({
			podId: "retry-me",
			ownership: "owned_untracked",
			hourlyBurn: 0.5,
			cleanup: { pending: true },
		});
		expect(pending.pods[0]?.cleanup.pendingAgeMs).toBeGreaterThanOrEqual(0);
		await expect(
			fixture.account.putLeaseIntent(testIntent("blocked-while-cleaning")),
		).rejects.toMatchObject({ code: "cleanup_pending" });
		expect(provider.creates).toBe(0);

		provider.retainDeletes = false;
		await fixture.account.reconcile("retry-cleanup");
		expect(provider.pods).toEqual([]);
		const clean = await fixture.account.readModel();
		expect(clean.reconcile.cleanupPending).toBe(0);
		expect(clean.inventory.podCount).toBe(0);
		expect(clean.pods[0]).toMatchObject({
			podId: "retry-me",
			phase: "absent",
			hourlyBurn: 0,
			cleanup: { pending: false },
		});
		expect(clean.pods[0]?.estimatedInfrastructureCost).not.toBeNull();
		expect(fixture.account.gate.status().open).toBe(true);

		const db = createClient({ url: `file:${fixture.account.dbPath}` });
		const queue = await db.execute(
			"SELECT cleanup_attempts, absence_confirmed_at FROM cleanup_queue WHERE pod_id = 'retry-me'",
		);
		expect(Number(queue.rows[0]?.cleanup_attempts)).toBe(2);
		expect(Number(queue.rows[0]?.absence_confirmed_at)).toBeGreaterThan(0);
		db.close();
		await fixture.account.stop();
	});

	test("the one always-on loop retries cleanup without any project scheduler", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods = [untrackedPod("periodic-retry", "periodic")];
		provider.retainDeletes = true;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		await fixture.account.start();
		expect((await fixture.account.readModel()).reconcile.cleanupPending).toBe(
			1,
		);

		provider.retainDeletes = false;
		const deadline = Date.now() + 3_000;
		while (provider.pods.length > 0 && Date.now() < deadline) {
			await Bun.sleep(25);
		}
		expect(provider.pods).toEqual([]);
		expect((await fixture.account.readModel()).reconcile.cleanupPending).toBe(
			0,
		);
		await fixture.account.stop();
	});

	test("reconciliation retries tracked terminating leases instead of adopting them", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("tracked-retry"),
		);
		await fixture.account.command(lease.ref, "tracked/provision", {
			type: "provision",
		});
		provider.retainDeletes = true;
		await expect(
			fixture.account.command(lease.ref, "tracked/dispose", {
				type: "dispose",
				reason: "test retry",
			}),
		).rejects.toMatchObject({ code: "absence_not_confirmed" });

		provider.retainDeletes = false;
		await fixture.account.reconcile("tracked-cleanup-retry");
		expect(provider.pods).toEqual([]);
		expect((await fixture.account.readModel()).pods[0]).toMatchObject({
			podId: "created-1",
			phase: "absent",
			hourlyBurn: 0,
		});
		await fixture.account.stop();
	});

	test("startup inventory is the remote dispatch gate", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		expect(fixture.account.gate.gate()).not.toBeNull();

		provider.listFailure = new Error("startup outage");
		await fixture.account.start();
		expect(fixture.account.gate.gate()?.reason).toContain("inventory failed");

		provider.listFailure = null;
		await fixture.account.reconcile("startup-retry");
		expect(fixture.account.gate.gate()).toBeNull();
		await fixture.account.stop();
	});
});
