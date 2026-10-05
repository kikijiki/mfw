import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { RemoteTransportError } from "../src/remote-agent-host.ts";
import { RunPodApiError } from "../src/runpod-client.ts";
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

describe("RunPod account read model and global policy", () => {
	test("migrates a v6 confirmed balance and preserves it across the next failed check", async () => {
		const provider = new FakeRunPodProvider();
		const first = await accountFixture(provider);
		homes.push(first.home);
		await first.account.readModel();
		await first.account.stop();

		const legacy = createClient({ url: `file:${first.account.dbPath}` });
		await legacy.execute(
			"ALTER TABLE account_balance RENAME COLUMN last_confirmed_credits TO remaining_credits",
		);
		await legacy.execute(
			"ALTER TABLE account_balance RENAME COLUMN last_confirmed_at TO observed_at",
		);
		await legacy.execute(
			`INSERT INTO account_balance
				(id, remaining_credits, observed_at, checked_at, error_code)
			 VALUES (1, 31.5, 123456, 123456, NULL)`,
		);
		await legacy.execute("PRAGMA user_version=6");
		legacy.close();

		provider.balanceFailure = new RunPodApiError(
			"network_error",
			"legacy migration failure canary",
		);
		const restarted = await accountFixture(provider, { mfwHome: first.home });
		await restarted.account.reconcile("post-migration-failure");
		expect((await restarted.account.readModel()).balance).toMatchObject({
			remainingCredits: 31.5,
			observedAt: 123456,
			error: "network_error",
			fresh: false,
		});
		await restarted.account.stop();
	});

	test("credential changes close first, serialize with account work, and removal stays closed", async () => {
		const provider = new FakeRunPodProvider();
		provider.credential = false;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		let competingIntent: Promise<unknown> | null = null;
		let competingSettled = false;

		await fixture.account.setCredential(async (validate) => {
			expect(fixture.account.gate.status().open).toBe(false);
			provider.credential = true;
			competingIntent = fixture.account
				.putLeaseIntent(testIntent("credential-serialized"))
				.then(() => {
					competingSettled = true;
				});
			await Bun.sleep(5);
			expect(competingSettled).toBe(false);
			await validate();
		});
		expect(fixture.account.gate.status().open).toBe(true);
		await competingIntent;

		await fixture.account.removeCredential(async () => {
			expect(fixture.account.gate.status().open).toBe(false);
			provider.credential = false;
		});
		expect(fixture.account.gate.status()).toMatchObject({
			open: false,
			reason: "RunPod credential was removed",
		});
		expect(provider.deletes).toEqual([]);

		provider.credential = true;
		let durableCredential = "working-key";
		await expect(
			fixture.account.setCredential(async (validate) => {
				durableCredential = "rp_rotation_canary_that_must_not_escape";
				provider.balanceFailure = new RunPodApiError(
					"network_error",
					"provider echoed rp_rotation_canary_that_must_not_escape",
				);
				try {
					await validate();
				} finally {
					durableCredential = "working-key";
					provider.balanceFailure = null;
				}
			}),
		).rejects.toMatchObject({ code: "credential_validation_failed" });
		expect(durableCredential).toBe("working-key");
		const failedValidation = await fixture.account.readModel();
		expect(failedValidation.credential).toMatchObject({
			ready: true,
			validationError: null,
		});
		expect(failedValidation.credential.validatedAt).toBeNumber();
		expect(failedValidation.gate.open).toBe(true);
		expect(JSON.stringify(failedValidation)).not.toContain(
			"rp_rotation_canary",
		);
		await fixture.account.stop();
	});

	test("rejects and removes a first invalid RunPod key without leaking it", async () => {
		const provider = new FakeRunPodProvider();
		provider.credential = false;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);

		await expect(
			fixture.account.setCredential(async (validate) => {
				provider.credential = true;
				provider.balanceFailure = new RunPodApiError(
					"http_error",
					"provider echoed rp_first_key_canary_that_must_not_escape",
				);
				try {
					await validate();
				} finally {
					provider.credential = false;
					provider.balanceFailure = null;
				}
			}),
		).rejects.toMatchObject({ code: "credential_validation_failed" });

		const model = await fixture.account.readModel();
		expect(model.credential).toMatchObject({
			ready: false,
			validatedAt: null,
			validationError: "credential_missing",
		});
		expect(model.gate.open).toBe(false);
		expect(JSON.stringify(model)).not.toContain("rp_first_key_canary");
		await fixture.account.stop();
	});

	test("migrates the pre-reconciliation account DB without losing account availability", async () => {
		const provider = new FakeRunPodProvider();
		const first = await accountFixture(provider);
		homes.push(first.home);
		await first.account.readModel();
		await first.account.stop();

		const old = createClient({ url: `file:${first.account.dbPath}` });
		await old.execute("DROP TABLE cleanup_queue");
		await old.execute("DROP TABLE account_balance");
		await old.execute("PRAGMA user_version=2");
		old.close();

		const restarted = await accountFixture(provider, { mfwHome: first.home });
		await restarted.account.readModel();
		const migrated = createClient({ url: `file:${restarted.account.dbPath}` });
		const version = await migrated.execute("PRAGMA user_version");
		const columns = await migrated.execute("PRAGMA table_info(cleanup_queue)");
		expect(Number(version.rows[0]?.user_version)).toBe(8);
		expect(columns.rows.map((row) => row.name)).toContain("observed_json");
		const balanceColumns = await migrated.execute(
			"PRAGMA table_info(account_balance)",
		);
		expect(balanceColumns.rows.map((row) => row.name)).toContain(
			"last_confirmed_credits",
		);
		const detachColumns = await migrated.execute(
			"PRAGMA table_info(detached_projects)",
		);
		expect(detachColumns.rows.map((row) => row.name)).toContain("project_id");
		migrated.close();
		await restarted.account.stop();
	});

	test("reconciles provider-reported remaining credits without inferring from spend", async () => {
		const provider = new FakeRunPodProvider();
		provider.balance = 88.25;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);

		await fixture.account.reconcile("balance-success");
		const available = await fixture.account.readModel();
		expect(available.balance).toMatchObject({
			remainingCredits: 88.25,
			currency: "USD",
			source: "RunPod clientBalance",
			inferredFromSpend: false,
			fresh: true,
			error: null,
		});
		expect(available.balance.observedAt).toBeNumber();
		expect(provider.balanceCalls).toBe(1);

		provider.balanceFailure = new RunPodApiError(
			"network_error",
			"provider echoed rp_secret_that_must_stay_redacted",
		);
		await expect(
			fixture.account.reconcile("balance-unavailable"),
		).resolves.toBeUndefined();
		const unavailable = await fixture.account.readModel();
		expect(unavailable.balance).toMatchObject({
			remainingCredits: 88.25,
			observedAt: available.balance.observedAt,
			fresh: false,
			error: "network_error",
		});
		expect(unavailable.balance.checkedAt).toBeGreaterThanOrEqual(
			available.balance.checkedAt ?? 0,
		);
		expect(unavailable.inventory.fresh).toBe(true);
		expect(JSON.stringify(unavailable)).not.toContain(
			"rp_secret_that_must_stay_redacted",
		);
		await fixture.account.stop();
	});

	test("two processes serialize fresh inventory and cannot oversubscribe the account cap", async () => {
		const provider = new FakeRunPodProvider();
		const first = await accountFixture(provider, {
			policy: { ...reconcilePolicy, maxConcurrentPods: 1 },
		});
		homes.push(first.home);
		const second = await accountFixture(provider, {
			mfwHome: first.home,
			policy: { ...reconcilePolicy, maxConcurrentPods: 1 },
		});
		const leaseA = await first.account.putLeaseIntent(
			testIntent("process-a", "project-a"),
		);
		const leaseB = await second.account.putLeaseIntent(
			testIntent("process-b", "project-b"),
		);

		const results = await Promise.allSettled([
			first.account.command(leaseA.ref, "a/provision", { type: "provision" }),
			second.account.command(leaseB.ref, "b/provision", {
				type: "provision",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(provider.creates).toBe(1);
		expect(provider.pods).toHaveLength(1);
		await first.account.stop();
		await second.account.stop();
	});

	test("read model keeps requested/actual shape, identities, ceilings, costs, and labels truthful", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("cost-run", "cost-project"),
		);
		await fixture.account.command(lease.ref, "cost/provision", {
			type: "provision",
		});

		const model = await fixture.account.readModel();
		expect(model.credential.ready).toBe(true);
		expect(model.inventory.fresh).toBe(true);
		expect(model.pods[0]).toMatchObject({
			ownership: "owned_tracked",
			projectId: "cost-project",
			taskId: "MFW-99",
			runId: "cost-run",
			attempt: 1,
			leaseRef: lease.ref,
			requestedShape: { computeType: "CPU", cpuFlavorId: "cpu5m" },
			actualShape: { computeType: "CPU", offeringId: "cpu5m", gpuCount: 0 },
			costPerHr: 0.5,
			adjustedCostPerHr: 0.4,
			hourlyBurn: 0.5,
		});
		expect(model.pods[0]?.ceilings.hard).toMatchObject({
			maxConcurrentPods: 3,
			maxAggregateHourlyPrice: 3,
		});
		expect(model.costs.providerInfrastructure).toMatchObject({
			label: "RunPod infrastructure",
			costPerHr: 0.5,
			adjustedCostPerHr: 0.4,
			hourlyBurn: 0.5,
		});
		expect(model.costs.agentTokens).toEqual({
			label: "Agent tokens",
			includedInInfrastructureCost: false,
			cost: null,
		});
		expect(model.historicalBilling).toEqual({
			available: false,
			key: "podId",
			gatesLiveSafety: false,
			records: [],
		});
		expect(JSON.stringify(model)).not.toContain("PROVIDER_SECRET");
		expect(JSON.stringify(model)).not.toContain("fixture-public-key");

		await fixture.account.requestCleanup({
			podId: "created-1",
			reason: "operator audit",
			actor: "test-operator",
			confirmed: true,
			expectedOwnershipFingerprint: model.pods[0]?.ownershipFingerprint ?? "",
			expectedObservedAt: model.inventory.observedAt ?? 0,
		});
		const absent = await fixture.account.readModel();
		expect(absent.pods[0]).toMatchObject({
			podId: "created-1",
			phase: "absent",
			desiredStatus: "ABSENT",
			cleanup: { pending: false },
		});
		expect(absent.pods[0]?.estimatedRuntimeHours).toBeGreaterThanOrEqual(0);
		expect(absent.pods[0]?.estimatedInfrastructureCost).not.toBeNull();
		await fixture.account.stop();
	});

	test("every cleanup decision audits a fresh redacted inventory and retry result", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods = [untrackedPod("audit-pod", "audit-run")];
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		await fixture.account.reconcile("audit-cleanup");

		const model = await fixture.account.readModel();
		const decisions = model.audit.filter((entry) =>
			entry.kind.startsWith("runpod_decision"),
		);
		expect(decisions.length).toBeGreaterThanOrEqual(2);
		for (const decision of decisions) {
			expect(decision.detail).toHaveProperty("reason");
			expect(decision.detail).toHaveProperty("decision");
			expect(decision.detail).toHaveProperty("attempt");
			expect(decision.detail).toHaveProperty("result");
			expect(decision.detail).toHaveProperty("inventory.observedAt");
			expect(decision.detail).toHaveProperty("inventory.pods");
		}
		const serialized = JSON.stringify(decisions);
		expect(serialized).not.toContain("must-never-be-persisted");
		expect(serialized).not.toContain("fixture-public-key");
		await fixture.account.stop();
	});

	test("persists versioned operator pause across restart and reconciles before resume", async () => {
		const provider = new FakeRunPodProvider();
		const first = await accountFixture(provider);
		homes.push(first.home);
		await first.account.start();
		const initial = await first.account.readModel();
		const paused = await first.account.setDispatchPaused({
			expectedVersion: initial.settings.version,
			paused: true,
			actor: "test-operator",
			reason: "maintenance window",
		});
		expect(paused.settings).toMatchObject({
			version: initial.settings.version + 1,
			dispatchPaused: true,
			updatedBy: "test-operator",
		});
		expect(paused.gate).toMatchObject({ open: false });
		await first.account.stop();

		const restarted = await accountFixture(provider, { mfwHome: first.home });
		await restarted.account.start();
		const afterRestart = await restarted.account.readModel();
		expect(afterRestart.settings.dispatchPaused).toBe(true);
		expect(afterRestart.gate).toMatchObject({
			open: false,
			reason: "RunPod dispatch is paused by the operator",
		});
		provider.listFailure = new RunPodApiError(
			"network_error",
			"resume prerequisite canary",
		);
		await expect(
			restarted.account.setDispatchPaused({
				expectedVersion: afterRestart.settings.version,
				paused: false,
				actor: "test-operator",
				reason: "unsafe resume attempt",
			}),
		).rejects.toMatchObject({ code: "network_error" });
		const stillPaused = await restarted.account.readModel();
		expect(stillPaused.settings).toMatchObject({
			version: afterRestart.settings.version,
			dispatchPaused: true,
		});
		expect(stillPaused.gate.open).toBe(false);
		provider.listFailure = null;
		const resumed = await restarted.account.setDispatchPaused({
			expectedVersion: stillPaused.settings.version,
			paused: false,
			actor: "test-operator",
			reason: "maintenance complete",
		});
		expect(resumed.settings.dispatchPaused).toBe(false);
		expect(resumed.inventory.fresh).toBe(true);
		expect(resumed.gate.open).toBe(true);
		await restarted.account.stop();
	});

	test("enables a new account with cost guardrails and no invented scale or shape limits", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider, {
			policy: { enabled: false },
		});
		homes.push(fixture.home);
		const initial = await fixture.account.readModel();
		const enabled = await fixture.account.updateMachineSafety({
			expectedVersion: initial.settings.version,
			actor: "local-operator",
			safety: {
				enabled: true,
				maxHourlyPrice: 1,
				maxAggregateHourlyPrice: 2,
				maxRuntimeMinutes: 90,
				maxRunSpend: 2,
			},
		});
		expect(enabled.settings.policy).toMatchObject({
			enabled: true,
			accountId: "default",
			maxHourlyPrice: 1,
			maxAggregateHourlyPrice: 2,
			maxRuntimeMinutes: 90,
			maxRunSpend: 2,
		});
		if (!enabled.settings.policy.enabled)
			throw new Error("expected enabled policy");
		for (const absent of [
			"allowedGpuTypes",
			"allowedCpuFlavors",
			"allowedImages",
			"allowedClouds",
			"maxGpuCount",
			"maxConcurrentPods",
			"sshProxyAccountSuffix",
			"sshHostPublicKey",
		] as const) {
			expect(enabled.settings.policy).not.toHaveProperty(absent);
		}
		expect(enabled.settings.policy.ownershipNamespace).toMatch(
			/^mfw:[0-9a-f-]{36}$/,
		);
		await fixture.account.stop();
	});

	test("lets a confirmed human settings flow raise or lower cost guardrails", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		await fixture.account.start();
		const initial = await fixture.account.readModel();
		const changed = await fixture.account.updateMachineSafety({
			expectedVersion: initial.settings.version,
			actor: "local-operator",
			safety: {
				enabled: true,
				maxHourlyPrice: 2,
				maxAggregateHourlyPrice: 4,
				maxRuntimeMinutes: 180,
				maxRunSpend: 6,
			},
		});
		expect(changed.settings.policy).toMatchObject({
			maxHourlyPrice: 2,
			maxAggregateHourlyPrice: 4,
			maxRuntimeMinutes: 180,
			maxRunSpend: 6,
		});
		expect(changed.inventory.fresh).toBe(true);
		await fixture.account.stop();
	});

	test("policy changes are versioned and cannot replace durable ownership identity", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		await fixture.account.start();
		const initial = await fixture.account.readModel();
		if (!initial.settings.policy.enabled)
			throw new Error("fixture is disabled");
		const changed = await fixture.account.updateMachinePolicy({
			expectedVersion: initial.settings.version,
			policy: { ...initial.settings.policy, maxHourlyPrice: 0.75 },
			actor: "test-operator",
			reason: "reduce single-pod ceiling",
		});
		expect(changed.settings.version).toBe(initial.settings.version + 1);
		expect(changed.policy.hard).toMatchObject({ maxHourlyPrice: 0.75 });
		await expect(
			fixture.account.updateMachinePolicy({
				expectedVersion: initial.settings.version,
				policy: { ...initial.settings.policy, maxHourlyPrice: 0.5 },
				actor: "stale-operator",
				reason: "stale write",
			}),
		).rejects.toMatchObject({ code: "settings_version_conflict" });
		await expect(
			fixture.account.updateMachinePolicy({
				expectedVersion: changed.settings.version,
				policy: {
					...initial.settings.policy,
					ownershipNamespace: "different-safe-namespace",
				},
				actor: "test-operator",
				reason: "replace identity",
			}),
		).rejects.toMatchObject({ code: "policy_safety_boundary_weakened" });
		const afterReject = await fixture.account.readModel();
		expect(afterReject.audit).toContainEqual(
			expect.objectContaining({ kind: "operator_policy_rejected" }),
		);
		await expect(
			fixture.account.updateMachinePolicy({
				expectedVersion: changed.settings.version,
				policy: { enabled: true, providerCredential: "must-not-persist" },
				actor: "test-operator",
				reason: "invalid policy",
			}),
		).rejects.toMatchObject({ code: "invalid_machine_policy" });
		const invalidAudit = await fixture.account.readModel();
		expect(JSON.stringify(invalidAudit.audit)).not.toContain(
			"must-not-persist",
		);
		expect(invalidAudit.audit).toContainEqual(
			expect.objectContaining({ kind: "operator_policy_rejected" }),
		);
		await fixture.account.stop();
	});

	test("cleanup refuses a changed ownership fingerprint before provider deletion", async () => {
		const provider = new FakeRunPodProvider();
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("identity-check", "identity-project"),
		);
		await fixture.account.command(lease.ref, "identity/provision", {
			type: "provision",
		});
		const model = await fixture.account.readModel();
		await expect(
			fixture.account.requestCleanup({
				podId: "created-1",
				reason: "test identity fence",
				actor: "test-operator",
				confirmed: true,
				expectedOwnershipFingerprint: "0".repeat(64),
				expectedObservedAt: model.inventory.observedAt ?? 0,
			}),
		).rejects.toMatchObject({ code: "cleanup_identity_changed" });
		expect(provider.deletes).toHaveLength(0);
		await fixture.account.stop();
	});

	test("operator can clean a freshly confirmed owned Pod withheld for an unavailable owner", async () => {
		const provider = new FakeRunPodProvider();
		provider.pods = [
			untrackedPod(
				"operator-untracked",
				"owner-unavailable",
				"sleeping-project",
			),
		];
		const fixture = await accountFixture(provider, {
			resolveOwner: async () => ({
				state: "unavailable",
				projectName: "sleeping-project",
				reason: "project_unavailable",
			}),
		});
		homes.push(fixture.home);

		await expect(
			fixture.account.reconcile("owner-unavailable"),
		).rejects.toMatchObject({ code: "owner_unavailable" });
		expect(provider.deletes).toEqual([]);
		const before = await fixture.account.readModel();
		const pod = before.pods.find(
			(candidate) => candidate.podId === "operator-untracked",
		);
		expect(pod).toMatchObject({
			ownership: "owned_untracked",
			cleanup: { pending: false },
		});

		const after = await fixture.account.requestCleanup({
			podId: "operator-untracked",
			reason: "Operator confirmed cleanup while owner is unavailable",
			actor: "test-operator",
			confirmed: true,
			expectedOwnershipFingerprint: pod?.ownershipFingerprint ?? "",
			expectedObservedAt: before.inventory.observedAt ?? 0,
		});
		expect(provider.deletes).toEqual(["operator-untracked"]);
		expect(provider.pods).toEqual([]);
		expect(
			after.pods.find((candidate) => candidate.podId === "operator-untracked"),
		).toMatchObject({ phase: "absent", cleanup: { pending: false } });
		expect(after.audit).toContainEqual(
			expect.objectContaining({ kind: "operator_untracked_cleanup_enqueued" }),
		);
		await fixture.account.stop();
	});

	test("accepts RunPod's comment-normalized PUBLIC_KEY while requiring matching controller fields", async () => {
		const provider = new FakeRunPodProvider();
		provider.injectPublicKeyAlias = true;
		provider.publicKeyAliasTransform = (key) =>
			`${key} runpod-provider-comment`;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("provider-key-alias", "alias-project"),
		);
		const ready = await fixture.account.command(lease.ref, "alias/provision", {
			type: "provision",
		});
		expect(ready.observedShape).toMatchObject({ verified: true });
		await fixture.account.command(lease.ref, "alias/dispose", {
			type: "dispose",
			reason: "test complete",
		});
		expect(provider.pods).toHaveLength(0);
		await fixture.account.stop();
	});

	test("pins the documented full-SSH public endpoint to the per-lease key", async () => {
		const provider = new FakeRunPodProvider();
		const hostKey = `ssh-ed25519 ${Buffer.alloc(32, 11).toString("base64")}`;
		const resolved: Array<[string, number]> = [];
		const fixture = await accountFixture(provider, {
			resolveSshHostKey: async (host, port) => {
				resolved.push([host, port]);
				return hostKey;
			},
		});
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("full-ssh", "ssh-project"),
		);
		await fixture.account.command(lease.ref, "full-ssh/provision", {
			type: "provision",
		});

		const connection = await fixture.account.connection(lease.ref);
		expect(resolved).toEqual([["194.26.0.7", 40123]]);
		expect(connection?.endpoint).toMatchObject({
			mode: "runpod-direct",
			principal: "root",
			host: "194.26.0.7",
			port: 40123,
			hostPublicKey: hostKey,
		});
		await fixture.account.stop();

		const restarted = await accountFixture(provider, {
			mfwHome: fixture.home,
			resolveSshHostKey: async () => {
				throw new Error(
					"a pinned lease must not guess or replace its host key",
				);
			},
		});
		const recovered = await restarted.account.connection(lease.ref);
		expect(recovered?.endpoint).toMatchObject({
			mode: "runpod-direct",
			principal: "root",
			host: "194.26.0.7",
			port: 40123,
			hostPublicKey: hostKey,
		});
		await restarted.account.stop();
	});

	test("waits when a running Pod publishes SSH before sshd is ready", async () => {
		const provider = new FakeRunPodProvider();
		const hostKey = `ssh-ed25519 ${Buffer.alloc(32, 12).toString("base64")}`;
		let attempts = 0;
		const fixture = await accountFixture(provider, {
			resolveSshHostKey: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new RemoteTransportError(
						"network_lost",
						"sshd is still starting",
					);
				}
				return hostKey;
			},
		});
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("ssh-readiness-race", "ssh-project"),
		);
		await fixture.account.command(lease.ref, "ssh-readiness-race/provision", {
			type: "provision",
		});

		expect(await fixture.account.connection(lease.ref)).toBeNull();
		expect(
			(await fixture.account.connection(lease.ref))?.endpoint,
		).toMatchObject({
			mode: "runpod-direct",
			hostPublicKey: hostKey,
		});
		expect(attempts).toBe(2);
		await fixture.account.stop();
	});

	test("rejects a provider PUBLIC_KEY alias with different key material", async () => {
		const provider = new FakeRunPodProvider();
		provider.injectPublicKeyAlias = true;
		provider.publicKeyAliasTransform = () =>
			`ssh-ed25519 ${Buffer.alloc(32, 3).toString("base64")}`;
		const fixture = await accountFixture(provider);
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(
			testIntent("provider-key-mismatch", "alias-project"),
		);
		await expect(
			fixture.account.command(lease.ref, "alias-mismatch/provision", {
				type: "provision",
			}),
		).rejects.toMatchObject({ code: "live_shape_policy_violation" });
		expect(provider.pods).toHaveLength(0);
		await fixture.account.stop();
	});

	test("an owned Pod whose attached run ended is adopted and delegated to supervisor finalization", async () => {
		const provider = new FakeRunPodProvider();
		let wakes = 0;
		const fixture = await accountFixture(provider, {
			resolveOwner: async () => ({
				state: "ended",
				projectName: "attached",
				resumeFinalization: () => {
					wakes++;
				},
			}),
		});
		homes.push(fixture.home);
		const lease = await fixture.account.putLeaseIntent(testIntent("ended-run"));
		await fixture.account.command(lease.ref, "ended/provision", {
			type: "provision",
		});
		await fixture.account.reconcile("join-ended-run");

		expect(provider.pods).toHaveLength(1);
		expect(provider.deletes).toEqual([]);
		expect(wakes).toBe(1);
		await fixture.account.stop();
	});
});
