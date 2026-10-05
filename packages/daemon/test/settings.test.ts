import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configPath,
	FALLBACK_MERGE_CHECKS,
	loadConfig,
	type RecoveryAssistance,
	saveConfig,
} from "../src/config.ts";
import { CredentialStore } from "../src/credentials.ts";
import {
	ProviderSettings,
	type SettingsAssistance,
	type SettingsBrain,
	type SettingsMergeQueue,
	type SettingsScheduler,
	SettingsService,
} from "../src/settings.ts";

/** Real config and credentials files: this surface exists to persist, so an in-memory double would prove nothing. */

/** A scheduler stand-in that records what the live-apply path did to it. */
class FakeScheduler implements SettingsScheduler {
	running = false;
	maxConcurrent = 2;
	selfRepairMainRed = true;
	starts = 0;
	stops = 0;
	setMaxConcurrent(n: number): void {
		this.maxConcurrent = n;
	}
	setSelfRepairMainRed(on: boolean): void {
		this.selfRepairMainRed = on;
	}
	start(): void {
		this.starts++;
		this.running = true;
	}
	async stop(): Promise<void> {
		this.stops++;
		this.running = false;
	}
}

class FakeBrain implements SettingsBrain {
	enabled = false;
	setEnabled(on: boolean): void {
		this.enabled = on;
	}
}

class FakeAssistance implements SettingsAssistance {
	value: RecoveryAssistance = {
		failureDiagnosis: "assisted",
		conflictResolution: "assisted",
		changeReview: "off",
	};
	constructor(private readonly brain: FakeBrain) {}
	set(value: RecoveryAssistance): void {
		this.value = value;
		this.brain.setEnabled(Object.values(value).includes("assisted"));
	}
}

class FakeMergeQueue implements SettingsMergeQueue {
	pushOnMerge = true;
	setPushOnMerge(on: boolean): void {
		this.pushOnMerge = on;
	}
}

interface Env {
	home: string;
	scheduler: FakeScheduler;
	brain: FakeBrain;
	mergeQueue: FakeMergeQueue;
	settings: SettingsService;
}

const envs: Env[] = [];
const savedHome = process.env.MFW_HOME;

async function freshEnv(): Promise<Env> {
	const home = await mkdtemp(join(tmpdir(), "mfw-settings-"));
	process.env.MFW_HOME = home;
	const scheduler = new FakeScheduler();
	const brain = new FakeBrain();
	const mergeQueue = new FakeMergeQueue();
	const assistance = new FakeAssistance(brain);
	const env: Env = {
		home,
		scheduler,
		brain,
		mergeQueue,
		settings: new SettingsService({
			mfwHome: home,
			project: "demo",
			root: "/tmp/demo",
			integrationBranch: "main",
			scheduler,
			brain,
			assistance,
			mergeQueue,
		}),
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		await rm(env.home, { recursive: true, force: true });
	}
	if (savedHome === undefined) delete process.env.MFW_HOME;
	else process.env.MFW_HOME = savedHome;
});

describe("get", () => {
	test("falls back to the shared project defaults when nothing is stored", async () => {
		const env = await freshEnv();
		const view = await env.settings.get();
		expect(view).toMatchObject({
			project: "demo",
			root: "/tmp/demo",
			integrationBranch: "main",
			configPath: configPath(),
		});
		expect(view.values).toEqual({
			approvalMode: "autonomous",
			reasoningEffort: "medium",
			maxConcurrent: 2,
			schedulerAutostart: false,
			assistance: {
				failureDiagnosis: "assisted",
				conflictResolution: "assisted",
				changeReview: "off",
			},
			provider: { id: "claude-cli", type: "claude-cli" },
			model: "sonnet",
			modelTiers: null,
			reviewModel: null,
			maxRepairs: 2,
			maxStalls: 3,
			maxResumes: 2,
			leaseMs: 900_000,
			checkPrefix: null,
			envPolicy: null,
			mergeChecks: FALLBACK_MERGE_CHECKS,
			notify: null,
			runpod: null,
			runpodTarget: null,
			selfRepairMainRed: true,
			// On by default, and reported from the live merge queue when nothing
			// is stored.
			pushOnMerge: true,
		});
		// Restart-only fields are named so the UI never claims a live apply.
		expect(view.needsRestart).toContain("model");
		expect(view.needsRestart).toContain("modelTiers");
		expect(view.needsRestart).toContain("reviewModel");
		expect(view.needsRestart).toContain("leaseMs");
		expect(view.needsRestart).not.toContain("maxConcurrent");
	});

	test("explicit review-off policy round-trips without an implicit critic", async () => {
		const env = await freshEnv();
		await env.settings.update({
			assistance: {
				failureDiagnosis: "assisted",
				conflictResolution: "escalate",
				changeReview: "off",
			},
		});
		expect((await env.settings.get()).values.assistance.changeReview).toBe(
			"off",
		);
		const [stored] = (await loadConfig()).projects;
		expect(stored?.assistance?.changeReview).toBe("off");
	});
});

describe("update", () => {
	test("persists to config.json and round-trips through a fresh load", async () => {
		const env = await freshEnv();
		const after = await env.settings.update({
			maxConcurrent: 5,
			model: "opus",
			reasoningEffort: "high",
			approvalMode: "interactive",
			maxRepairs: 0,
			leaseMs: 60_000,
			checkPrefix: "ci:",
			notify: { webhook: "https://example.com/hook" },
		});
		expect(after.values).toMatchObject({
			maxConcurrent: 5,
			model: "opus",
			reasoningEffort: "high",
			approvalMode: "interactive",
			maxRepairs: 0,
			leaseMs: 60_000,
			checkPrefix: "ci:",
			notify: { webhook: "https://example.com/hook" },
		});

		// On disk, in the config the daemon reads at boot.
		const onDisk = JSON.parse(await readFile(configPath(), "utf8"));
		expect(onDisk.projects).toEqual([
			{
				name: "demo",
				root: "/tmp/demo",
				maxConcurrent: 5,
				model: "opus",
				reasoningEffort: "high",
				approvalMode: "interactive",
				maxRepairs: 0,
				leaseMs: 60_000,
				checkPrefix: "ci:",
				notify: { webhook: "https://example.com/hook" },
			},
		]);
		const reloaded = await loadConfig();
		expect(reloaded.projects[0]?.model).toBe("opus");
		expect(reloaded.projects[0]?.reasoningEffort).toBe("high");
		expect(reloaded.projects[0]?.approvalMode).toBe("interactive");

		// A second update merges rather than replacing the entry.
		await env.settings.update({ maxStalls: 7 });
		const merged = (await loadConfig()).projects[0];
		expect(merged).toMatchObject({ model: "opus", maxStalls: 7 });
	});

	test("model tiers and the review model round-trip, and null clears them", async () => {
		const env = await freshEnv();
		const after = await env.settings.update({
			modelTiers: { light: "haiku", strong: "opus" },
			reviewModel: "claude-opus-5",
		});
		expect(after.values.modelTiers).toEqual({ light: "haiku", strong: "opus" });
		expect(after.values.reviewModel).toBe("claude-opus-5");

		const reloaded = await loadConfig();
		expect(reloaded.projects[0]?.modelTiers).toEqual({
			light: "haiku",
			strong: "opus",
		});
		expect(reloaded.projects[0]?.reviewModel).toBe("claude-opus-5");

		const cleared = await env.settings.update({
			modelTiers: null,
			reviewModel: null,
		});
		expect(cleared.values.modelTiers).toBeNull();
		expect(cleared.values.reviewModel).toBeNull();
		const reclearedOnDisk = (await loadConfig()).projects[0];
		expect(reclearedOnDisk?.modelTiers).toBeUndefined();
		expect(reclearedOnDisk?.reviewModel).toBeUndefined();
	});

	test("applies live what can be applied, and leaves other projects alone", async () => {
		const env = await freshEnv();
		await saveConfig({
			projects: [
				{ name: "other", root: "/tmp/other", model: "haiku" },
				{ name: "demo", root: "/tmp/demo" },
			],
		});

		await env.settings.update({
			maxConcurrent: 6,
			assistance: {
				failureDiagnosis: "assisted",
				conflictResolution: "escalate",
				changeReview: "human",
			},
		});
		expect(env.scheduler.maxConcurrent).toBe(6);
		expect(env.brain.enabled).toBe(true);

		// schedulerAutostart drives the loop immediately, both ways.
		await env.settings.update({ schedulerAutostart: true });
		expect(env.scheduler.starts).toBe(1);
		expect(env.scheduler.running).toBe(true);
		await env.settings.update({ schedulerAutostart: false });
		expect(env.scheduler.stops).toBe(1);
		expect(env.scheduler.running).toBe(false);

		// A restart-only field does NOT touch the live services.
		await env.settings.update({ model: "opus" });
		expect(env.scheduler.maxConcurrent).toBe(6);

		const config = await loadConfig();
		expect(config.projects.map((p) => p.name)).toEqual(["other", "demo"]);
		expect(config.projects.find((p) => p.name === "other")?.model).toBe(
			"haiku",
		);
		expect(config.projects.find((p) => p.name === "demo")).toMatchObject({
			maxConcurrent: 6,
			assistance: {
				failureDiagnosis: "assisted",
				conflictResolution: "escalate",
				changeReview: "human",
			},
			schedulerAutostart: false,
			model: "opus",
		});
	});

	test("MFW-28: selfRepairMainRed applies live and persists, opt-in per project", async () => {
		const env = await freshEnv();
		expect((await env.settings.get()).values.selfRepairMainRed).toBe(true);

		await env.settings.update({ selfRepairMainRed: false });
		expect(env.scheduler.selfRepairMainRed).toBe(false);
		expect((await env.settings.get()).values.selfRepairMainRed).toBe(false);

		const config = await loadConfig();
		expect(
			config.projects.find((p) => p.name === "demo")?.selfRepairMainRed,
		).toBe(false);
	});

	test("pushOnMerge applies live and persists, and is ON unless turned off", async () => {
		const env = await freshEnv();
		// Unlike the rest of the switches, this one starts enabled.
		expect((await env.settings.get()).values.pushOnMerge).toBe(true);

		await env.settings.update({ pushOnMerge: false });
		expect(env.mergeQueue.pushOnMerge).toBe(false);
		expect((await env.settings.get()).values.pushOnMerge).toBe(false);

		const config = await loadConfig();
		expect(config.projects.find((p) => p.name === "demo")?.pushOnMerge).toBe(
			false,
		);
	});

	test("stores a provider a run can actually be launched with", async () => {
		const env = await freshEnv();
		const after = await env.settings.update({
			provider: { id: "claude-cli", env: { MFW_TEST: "1" } },
		});
		expect(after.values.provider).toEqual({
			id: "claude-cli",
			type: "claude-cli",
			env: { MFW_TEST: "1" },
		});
		// The adapter `type` is derived, never taken from the caller.
		expect((await loadConfig()).projects[0]?.provider).toEqual({
			id: "claude-cli",
			type: "claude-cli",
			env: { MFW_TEST: "1" },
		});
		// It only takes effect on the next boot, and says so.
		expect(after.needsRestart).toContain("provider");
	});

	test("switches providers with its model default and refuses unsupported ids", async () => {
		const env = await freshEnv();
		await env.settings.update({ maxStalls: 4 });

		const codex = await env.settings.update({ provider: { id: "codex-cli" } });
		expect(codex.values.provider.type).toBe("codex-cli");
		expect(codex.values.model).toBe("gpt-5.6-sol");
		expect(
			env.settings.update({ provider: { id: "gemini-cli" } }),
		).rejects.toThrow(/cannot be run/);
		expect(
			env.settings.update({ provider: { id: "made-up" } }),
		).rejects.toThrow(/unknown provider/);

		// The rejected write left the stored entry unchanged (a non-launchable CLI would fail every run).
		const stored = (await loadConfig()).projects[0];
		expect(stored?.provider?.id).toBe("codex-cli");
		expect(stored?.model).toBe("gpt-5.6-sol");
		expect(stored?.maxStalls).toBe(4);
	});

	test("clamps nonsense values instead of persisting them", async () => {
		const env = await freshEnv();
		const view = await env.settings.update({ maxConcurrent: 0, leaseMs: 1 });
		expect(view.values.maxConcurrent).toBe(1);
		expect(view.values.leaseMs).toBe(1000);
	});
});

describe("providers", () => {
	test("coordinates account-provider mutations and never hands keys to coordinators", async () => {
		const env = await freshEnv();
		const store = CredentialStore.at(env.home);
		const events: string[] = [];
		const providers = new ProviderSettings(store, {
			runpod: {
				setCredential: async (mutate) => {
					events.push("runpod:set:closed");
					await mutate(async () => {
						events.push("runpod:set:validated");
					});
					events.push(
						`runpod:set:stored:${(await store.get("runpod")) !== undefined}`,
					);
				},
				removeCredential: async (mutate) => {
					events.push("runpod:remove:closed");
					await mutate();
					events.push(
						`runpod:remove:stored:${(await store.get("runpod")) !== undefined}`,
					);
				},
			},
		});

		const key = "rp_write_only_canary";
		await providers.set("runpod", key);
		await providers.set("anthropic", "generic-key");
		await providers.remove("runpod");
		expect(events).toEqual([
			"runpod:set:closed",
			"runpod:set:validated",
			"runpod:set:stored:true",
			"runpod:remove:closed",
			"runpod:remove:stored:false",
		]);
		expect(JSON.stringify(events)).not.toContain(key);
		expect(await store.get("anthropic")).toBe("generic-key");
	});

	test("routes OpenRouter credential changes through its validator", async () => {
		const env = await freshEnv();
		const store = CredentialStore.at(env.home);
		const events: string[] = [];
		const providers = new ProviderSettings(store, {
			openrouter: {
				setCredential: async (mutate) => {
					events.push("set:begin");
					await mutate(async () => {
						events.push("set:validated");
					});
					events.push(
						`set:stored:${(await store.get("openrouter")) !== undefined}`,
					);
				},
				removeCredential: async (mutate) => {
					events.push("remove:begin");
					await mutate();
				},
			},
		});

		await providers.set("openrouter", "sk-or-write-only-canary");
		await providers.remove("openrouter");
		expect(events).toEqual([
			"set:begin",
			"set:validated",
			"set:stored:true",
			"remove:begin",
		]);
		expect(await store.get("openrouter")).toBeUndefined();
	});

	test("routes the OpenRouter management credential independently", async () => {
		const env = await freshEnv();
		const store = CredentialStore.at(env.home);
		const events: string[] = [];
		const providers = new ProviderSettings(store, {
			openrouterManagement: {
				setCredential: async (mutate) => {
					await mutate(async () => {
						events.push("validated");
					});
				},
				removeCredential: async (mutate) => {
					await mutate();
					events.push("removed");
				},
			},
		});

		await providers.set("openrouter-management", "sk-or-management-canary");
		expect(await store.get("openrouter-management")).toBe(
			"sk-or-management-canary",
		);
		await providers.remove("openrouter-management");
		expect(events).toEqual(["validated", "removed"]);
		expect(await store.get("openrouter-management")).toBeUndefined();
	});

	test("keeps the last RunPod key when candidate validation fails", async () => {
		const env = await freshEnv();
		const store = CredentialStore.at(env.home);
		await store.set("runpod", "rp_prior_working_canary");
		const providers = new ProviderSettings(store, {
			runpod: {
				setCredential: (mutate) =>
					mutate(async () => {
						expect(await store.get("runpod")).toBe(
							"rp_rejected_candidate_canary",
						);
						const durable = JSON.parse(
							await readFile(join(env.home, "credentials.json"), "utf8"),
						) as { providers: Record<string, { apiKey: string }> };
						expect(durable.providers.runpod?.apiKey).toBe(
							"rp_prior_working_canary",
						);
						throw new Error("candidate rejected without echoing its value");
					}),
				removeCredential: async (mutate) => mutate(),
			},
		});

		await expect(
			providers.set("runpod", "rp_rejected_candidate_canary"),
		).rejects.toThrow("candidate rejected without echoing its value");
		expect(await store.get("runpod")).toBe("rp_prior_working_canary");
	});

	test("reports presence only: a stored key is never echoed back", async () => {
		const env = await freshEnv();
		const providers = new ProviderSettings(CredentialStore.at(env.home));
		expect(await providers.list()).toEqual([]);
		expect(await providers.status("anthropic")).toEqual({
			id: "anthropic",
			hasKey: false,
		});

		const secret = "sk-super-secret-value";
		expect(await providers.set("anthropic", secret)).toEqual({
			id: "anthropic",
			hasKey: true,
		});
		await providers.set("openrouter", "sk-other");

		const listed = await providers.list();
		expect(listed).toEqual([
			{ id: "anthropic", hasKey: true },
			{ id: "openrouter", hasKey: true },
		]);
		// Nothing anywhere in the response can carry the key.
		expect(JSON.stringify(listed)).not.toContain(secret);
		expect(JSON.stringify(await providers.status("anthropic"))).not.toContain(
			secret,
		);

		// It really was stored: the daemon reads it from the store directly.
		expect(await CredentialStore.at(env.home).get("anthropic")).toBe(secret);

		expect(await providers.remove("anthropic")).toEqual({
			id: "anthropic",
			hasKey: false,
		});
		expect((await providers.list()).map((p) => p.id)).toEqual(["openrouter"]);
	});
});
