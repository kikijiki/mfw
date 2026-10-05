import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CredentialStore,
	WorkloadSecretGrantStore,
} from "../src/credentials.ts";

describe("CredentialStore", () => {
	test("set/get/remove round-trip with 0600 mode and no temp litter", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-cred-"));
		const store = CredentialStore.at(home);
		expect(await store.get("openrouter")).toBeUndefined();

		await store.set("openrouter", "sk-abc");
		await store.set("anthropic", "sk-def");
		expect(await store.get("openrouter")).toBe("sk-abc");
		expect((await store.list()).sort()).toEqual(["anthropic", "openrouter"]);

		const mode = (await stat(join(home, "credentials.json"))).mode & 0o777;
		expect(mode).toBe(0o600);
		const litter = (await readdir(home)).filter((f) => f.startsWith(".tmp-"));
		expect(litter).toEqual([]);

		await store.remove("openrouter");
		expect(await store.get("openrouter")).toBeUndefined();
		expect(await store.get("anthropic")).toBe("sk-def");
		await rm(home, { recursive: true, force: true });
	});

	test("malformed file fails loudly instead of silently losing keys", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-cred-"));
		await writeFile(join(home, "credentials.json"), "{not json");
		const store = CredentialStore.at(home);
		await expect(store.get("x")).rejects.toThrow(/malformed/);
		await rm(home, { recursive: true, force: true });
	});

	test("an unreadable credential file aborts mutation without replacing secrets", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-cred-unreadable-"));
		const path = join(home, "credentials.json");
		try {
			const store = CredentialStore.at(home);
			await store.set("existing", "must-survive");
			const before = await readFile(path, "utf8");
			await chmod(path, 0o000);
			await expect(
				store.set("new", "must-not-overwrite"),
			).rejects.toMatchObject({ code: "EACCES" });
			await chmod(path, 0o600);
			expect(await readFile(path, "utf8")).toBe(before);
			expect(await store.get("existing")).toBe("must-survive");
			expect(await store.get("new")).toBeUndefined();
		} finally {
			await chmod(path, 0o600).catch(() => {});
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an unreadable workload-grant file aborts mutation without replacement", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-grant-unreadable-"));
		const path = join(home, "workload-secret-grants.json");
		try {
			const grants = WorkloadSecretGrantStore.at(home);
			await grants.put({
				id: "existing",
				projectId: "project-1",
				taskIds: null,
				environment: "EXISTING_TOKEN",
				source: { kind: "secret", id: "existing-token" },
			});
			const before = await readFile(path, "utf8");
			await chmod(path, 0o000);
			await expect(
				grants.put({
					id: "new",
					projectId: "project-1",
					taskIds: null,
					environment: "NEW_TOKEN",
					source: { kind: "secret", id: "new-token" },
				}),
			).rejects.toMatchObject({ code: "EACCES" });
			await chmod(path, 0o600);
			expect(await readFile(path, "utf8")).toBe(before);
			expect((await grants.list()).map((grant) => grant.id)).toEqual([
				"existing",
			]);
		} finally {
			await chmod(path, 0o600).catch(() => {});
			await rm(home, { recursive: true, force: true });
		}
	});

	test("concurrent provider and workload-secret mutations preserve every key", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-cred-race-"));
		try {
			const stores = Array.from({ length: 24 }, () => CredentialStore.at(home));
			await Promise.all(
				stores.map((store, index) =>
					index % 2 === 0
						? store.set(`provider-${index}`, `provider-value-${index}`)
						: store.setSecret(`secret-${index}`, `secret-value-${index}`),
				),
			);

			const reader = CredentialStore.at(home);
			expect((await reader.list()).sort()).toEqual(
				Array.from(
					{ length: 12 },
					(_, index) => `provider-${index * 2}`,
				).sort(),
			);
			expect((await reader.listSecrets()).sort()).toEqual(
				Array.from(
					{ length: 12 },
					(_, index) => `secret-${index * 2 + 1}`,
				).sort(),
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("unrelated concurrent writes cannot resurrect revoked values", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-cred-revoke-race-"));
		try {
			const seed = CredentialStore.at(home);
			await seed.set("revoked-provider", "old-provider-value");
			await seed.setSecret("revoked-secret", "old-secret-value");

			await Promise.all([
				CredentialStore.at(home).remove("revoked-provider"),
				CredentialStore.at(home).set("kept-provider", "new-provider-value"),
				CredentialStore.at(home).removeSecret("revoked-secret"),
				CredentialStore.at(home).setSecret("kept-secret", "new-secret-value"),
			]);

			const reader = CredentialStore.at(home);
			expect(await reader.get("revoked-provider")).toBeUndefined();
			expect(await reader.getSecret("revoked-secret")).toBeUndefined();
			expect(await reader.get("kept-provider")).toBe("new-provider-value");
			expect(await reader.getSecret("kept-secret")).toBe("new-secret-value");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("workload secrets require an out-of-band project/task grant and explicit selection", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-workload-grant-"));
		const canary = "MFW97_GRANT_CANARY_z8p";
		const credentials = CredentialStore.at(home);
		const grants = WorkloadSecretGrantStore.at(home);
		await credentials.setSecret("agent_token", canary);
		await grants.put({
			id: "agent-for-task-97",
			projectId: "project-1",
			taskIds: ["MFW-97"],
			environment: "AGENT_TOKEN",
			source: { kind: "secret", id: "agent_token" },
		});

		expect(
			(
				await grants.resolve(
					{
						projectId: "project-1",
						taskId: "MFW-97",
						grantIds: [],
					},
					credentials,
				)
			).isEmpty(),
		).toBe(true);
		const selected = await grants.resolve(
			{
				projectId: "project-1",
				taskId: "MFW-97",
				grantIds: ["agent-for-task-97"],
			},
			credentials,
		);
		expect(selected.names()).toEqual(["AGENT_TOKEN"]);
		expect(JSON.stringify(selected)).not.toContain(canary);
		const firstBinding = await grants.resolveBound(
			{
				projectId: "project-1",
				taskId: "MFW-97",
				grantIds: ["agent-for-task-97"],
			},
			credentials,
		);
		await credentials.setSecret("agent_token", "rotated-value");
		const rotatedBinding = await grants.resolveBound(
			{
				projectId: "project-1",
				taskId: "MFW-97",
				grantIds: ["agent-for-task-97"],
			},
			credentials,
		);
		expect(rotatedBinding.binding).not.toBe(firstBinding.binding);
		expect(firstBinding.binding).not.toContain(canary);
		expect(rotatedBinding.binding).not.toContain("rotated-value");
		await expect(
			grants.resolve(
				{
					projectId: "project-1",
					taskId: "MFW-98",
					grantIds: ["agent-for-task-97"],
				},
				credentials,
			),
		).rejects.toThrow(/not approved for this task/);

		const mode =
			(await stat(join(home, "workload-secret-grants.json"))).mode & 0o777;
		expect(mode).toBe(0o600);
		const grantBytes = await Bun.file(
			join(home, "workload-secret-grants.json"),
		).text();
		expect(grantBytes).not.toContain(canary);
		await expect(
			grants.put({
				id: "never-runpod",
				projectId: "project-1",
				taskIds: null,
				environment: "RUNPOD_API_KEY",
				source: { kind: "provider", id: "runpod" },
			}),
		).rejects.toThrow(/control-plane-only/);
		await credentials.set("runpod", "provider-control-plane-canary");
		await writeFile(
			join(home, "workload-secret-grants.json"),
			JSON.stringify({
				version: 1,
				grants: {
					bypassed_writer: {
						id: "bypassed_writer",
						projectId: "project-1",
						taskIds: null,
						environment: "INNOCENT_NAME",
						source: { kind: "provider", id: "runpod" },
					},
				},
			}),
		);
		await expect(
			grants.resolve(
				{
					projectId: "project-1",
					taskId: "MFW-98",
					grantIds: ["bypassed_writer"],
				},
				credentials,
			),
		).rejects.toThrow(/control-plane-only/);
		await rm(home, { recursive: true, force: true });
	});
});
