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
import { silentLogger } from "../src/log.ts";
import type { RoutingSettings } from "../src/routing.ts";
import {
	ProviderSettings,
	type SettingsAssistance,
	type SettingsBrain,
	type SettingsMergeQueue,
	type SettingsRouting,
	type SettingsScheduler,
	SettingsService,
} from "../src/settings.ts";
import { Supervisor, type SupervisorDeps } from "../src/supervisor.ts";

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

async function freshEnv(routing?: SettingsRouting): Promise<Env> {
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
			...(routing ? { routing } : {}),
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
			icon: null,
			color: null,
			approvalMode: "autonomous",
			reasoningEffort: "medium",
			maxConcurrent: 2,
			schedulerAutostart: false,
			assistance: {
				changeReview: "off",
			},
			provider: { id: "claude-cli", type: "claude-cli" },
			model: "sonnet",
			modelTiers: null,
			reviewModel: null,
			// Owner decision: reviewers must be independent by default.
			review: {
				mode: "critic",
				requireIndependent: true,
				maxRounds: 2,
				fallbackModels: [],
			},
			leaseMs: 900_000,
			checkPrefix: null,
			envPolicy: null,
			mergeChecks: FALLBACK_MERGE_CHECKS,
			notify: null,
			runpod: null,
			runpodTarget: null,
			routing: null,
			brain: null,
			docs: [],
			selfRepairMainRed: true,
			// On by default, and reported from the live merge queue when nothing
			// is stored.
			pushOnMerge: true,
			watchdog: {
				idleMs: 300_000,
				wallMs: 2_700_000,
				maxTurns: 0,
				scope: {
					mode: "kill",
					maxFiles: 150,
					sampleMs: 30_000,
					foreignOwned: "kill",
					onFinish: "review",
				},
			},
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
			leaseMs: 60_000,
			checkPrefix: "ci:",
			notify: { webhook: "https://example.com/hook" },
		});
		expect(after.values).toMatchObject({
			maxConcurrent: 5,
			model: "opus",
			reasoningEffort: "high",
			approvalMode: "interactive",
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
		await env.settings.update({ leaseMs: 70_000 });
		const merged = (await loadConfig()).projects[0];
		expect(merged).toMatchObject({ model: "opus", leaseMs: 70_000 });
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

	test("assisted review with a reviewer equal to the worker is refused, with the fix", async () => {
		const env = await freshEnv();
		const assisted = {
			changeReview: "assisted" as const,
		};
		// Default reviewer = the project model "sonnet" = the worker.
		const refused = env.settings.update({ assistance: assisted });
		await expect(refused).rejects.toThrow(/reviewer model 'sonnet'/);
		await expect(refused).rejects.toThrow(/different tier/);
		await expect(refused).rejects.toMatchObject({
			name: "ReviewIndependenceError",
		});
		// Nothing was written.
		expect((await loadConfig()).projects[0]?.assistance).toBeUndefined();

		// A tier model equal to the reviewer is a clash too.
		await expect(
			env.settings.update({
				assistance: assisted,
				reviewModel: "opus",
				modelTiers: { strong: "opus" },
			}),
		).rejects.toThrow(/modelTiers.strong/);

		// A different reviewer, a covering fallback, or the switch off all pass.
		const ok = await env.settings.update({
			assistance: assisted,
			reviewModel: "opus",
		});
		expect(ok.values.reviewModel).toBe("opus");
		await env.settings.update({
			reviewModel: null,
			review: { fallbackModels: ["opus"] },
		});
		const off = await env.settings.update({
			review: { requireIndependent: false, fallbackModels: [] },
		});
		expect(off.values.review).toMatchObject({
			requireIndependent: false,
			mode: "critic",
		});
		// Turning the switch back on over an equal pair is itself refused...
		await expect(
			env.settings.update({ review: { requireIndependent: true } }),
		).rejects.toThrow(/requireIndependent/);
		// ...but an equal pair already on disk never blocks unrelated patches.
		const config = await loadConfig();
		const entry = config.projects[0];
		if (entry) entry.review = { requireIndependent: true };
		await saveConfig(config);
		await expect(
			env.settings.update({ leaseMs: 120_000 }),
		).resolves.toBeDefined();
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
				changeReview: "human",
			},
		});
		expect(env.scheduler.maxConcurrent).toBe(6);

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

	test("watchdog applies live to the supervisor, merges field by field, and null restores defaults", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-settings-"));
		process.env.MFW_HOME = home;
		// A real Supervisor: `limits` is what its observe pass reads every time.
		const supervisor = new Supervisor({
			log: silentLogger(),
			registry: {},
		} as unknown as SupervisorDeps);
		const scheduler = new FakeScheduler();
		const brain = new FakeBrain();
		const settings = new SettingsService({
			mfwHome: home,
			project: "demo",
			root: "/tmp/demo",
			integrationBranch: "main",
			scheduler,
			brain,
			assistance: new FakeAssistance(brain),
			mergeQueue: new FakeMergeQueue(),
			supervisor,
		});
		try {
			expect((await settings.get()).needsRestart).not.toContain("watchdog");
			expect(supervisor.limits.idleMs).toBe(300_000);

			await settings.update({
				watchdog: { idleMs: 60_000, scope: { maxFiles: 40 } },
			});
			expect(supervisor.limits.idleMs).toBe(60_000);
			expect(supervisor.limits.scope.maxFiles).toBe(40);
			expect(supervisor.limits.scope.mode).toBe("kill");

			// A second patch keeps the first one's other fields.
			await settings.update({ watchdog: { scope: { mode: "warn" } } });
			expect(supervisor.limits).toMatchObject({
				idleMs: 60_000,
				scope: { maxFiles: 40, mode: "warn" },
			});
			const [stored] = (await loadConfig(home)).projects;
			expect(stored?.watchdog).toEqual({
				idleMs: 60_000,
				scope: { maxFiles: 40, mode: "warn" },
			});

			await settings.update({ watchdog: null });
			expect(supervisor.limits.idleMs).toBe(300_000);
			expect(supervisor.limits.scope.maxFiles).toBe(150);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
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
		await env.settings.update({ leaseMs: 120_000 });

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
		expect(stored?.leaseMs).toBe(120_000);
	});

	test("provider, model and routing apply live through the routing source", async () => {
		const applied: RoutingSettings[] = [];
		const env = await freshEnv({ set: (s) => applied.push(s) });
		const view = await env.settings.update({
			routing: {
				endpoints: {
					local: { baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3-coder" },
				},
				fallbacks: { default: [{ provider: "local" }] },
			},
			provider: { id: "codex-cli", endpoint: "local" },
		});
		// No restart: the routing keys are live once a routing source exists.
		for (const key of ["provider", "model", "modelTiers", "routing"] as const)
			expect(view.needsRestart).not.toContain(key);
		expect(view.values.provider).toMatchObject({
			id: "codex-cli",
			endpoint: "local",
		});
		expect(view.values.model).toBe("qwen3-coder");
		expect(applied.at(-1)?.provider.endpoint).toEqual({
			id: "local",
			baseUrl: "http://127.0.0.1:8080/v1",
		});
		await env.settings.update({ model: "other" });
		expect(applied.at(-1)?.model).toBe("other");
		// Unrelated keys do not touch routing.
		const before = applied.length;
		await env.settings.update({ leaseMs: 120_000 });
		expect(applied.length).toBe(before);
	});

	test("refuses an endpoint the routing does not define, a key without a grant, and an endpoint on Claude", async () => {
		const env = await freshEnv({ set: () => {} });
		await expect(
			env.settings.update({ provider: { id: "codex-cli", endpoint: "nope" } }),
		).rejects.toThrow(/not defined/);
		await expect(
			env.settings.update({
				routing: {
					endpoints: {
						or: {
							baseUrl: "https://openrouter.ai/api/v1",
							envKey: "OPENROUTER_API_KEY",
						},
					},
				},
			}),
		).rejects.toThrow(/grant/);
		await env.settings.update({
			routing: { endpoints: { local: { baseUrl: "http://127.0.0.1:1/v1" } } },
		});
		await expect(
			env.settings.update({
				provider: { id: "claude-cli", endpoint: "local" },
			}),
		).rejects.toThrow(/only codex-cli/);
		expect((await loadConfig()).projects[0]?.provider).toBeUndefined();
	});

	test("clamps nonsense values instead of persisting them", async () => {
		const env = await freshEnv();
		const view = await env.settings.update({ maxConcurrent: 0, leaseMs: 1 });
		expect(view.values.maxConcurrent).toBe(1);
		expect(view.values.leaseMs).toBe(1000);
	});
});

describe("project appearance", () => {
	test("icon and colour persist, round-trip, and null clears them", async () => {
		const env = await freshEnv();
		await env.settings.update({ icon: "rocket", color: "teal" });
		const view = await env.settings.get();
		expect(view.values.icon).toBe("rocket");
		expect(view.values.color).toBe("teal");
		expect((await loadConfig()).projects[0]).toMatchObject({
			icon: "rocket",
			color: "teal",
		});
		await env.settings.update({ icon: "K9" });
		expect((await env.settings.get()).values.icon).toBe("K9");
		await env.settings.update({ icon: null, color: null });
		const cleared = (await env.settings.get()).values;
		expect(cleared.icon).toBeNull();
		expect(cleared.color).toBeNull();
	});

	test("an unknown icon key, an over-long mark and an unknown colour are refused and change nothing", async () => {
		const env = await freshEnv();
		await env.settings.update({ icon: "rocket" });
		await expect(env.settings.update({ icon: "unicorn" })).rejects.toThrow(
			/unknown icon/,
		);
		await expect(env.settings.update({ icon: "abc" })).rejects.toThrow(
			/unknown icon|mark/,
		);
		await expect(env.settings.update({ icon: "a b" })).rejects.toThrow(/mark/);
		await expect(
			env.settings.update({ color: "#ff0000", maxConcurrent: 5 }),
		).rejects.toThrow(/unknown colour/);
		const values = (await env.settings.get()).values;
		expect(values.icon).toBe("rocket");
		expect(values.maxConcurrent).toBe(2);
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

describe("brain", () => {
	test("a patch persists, applies live, and null turns the brain off", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-settings-brain-"));
		process.env.MFW_HOME = home;
		const brain = new FakeBrain();
		const seen: unknown[] = [];
		const settings = new SettingsService({
			mfwHome: home,
			project: "demo",
			root: "/tmp/demo",
			integrationBranch: "main",
			scheduler: new FakeScheduler(),
			brain,
			assistance: new FakeAssistance(brain),
			mergeQueue: new FakeMergeQueue(),
			brainConfig: { set: (c) => seen.push(c) },
		});
		envs.push({ home } as Env);

		const on = await settings.update({
			brain: {
				routes: [{ provider: "claude-cli", model: "opus" }],
				heartbeatMin: 15,
				maxTurnsPerDay: 80,
			},
		});
		expect(on.values.brain).toEqual({
			routes: [{ provider: "claude-cli", model: "opus" }],
			heartbeatMin: 15,
			maxTurnsPerDay: 80,
		});
		expect(seen).toEqual([on.values.brain]);
		expect(on.needsRestart).not.toContain("brain");
		const stored = await loadConfig(home);
		expect(stored.projects.find((p) => p.name === "demo")?.brain).toEqual(
			on.values.brain as never,
		);

		const off = await settings.update({ brain: null });
		expect(off.values.brain).toBeNull();
		expect(seen.at(-1)).toBeUndefined();
	});

	test("without a live sink the brain change is reported as needing a restart", async () => {
		const env = await freshEnv();
		const view = await env.settings.update({
			brain: { routes: [{ provider: "claude-cli" }] },
		});
		expect(view.needsRestart).toContain("brain");
	});
});

describe("docs sources", () => {
	async function envWithRepo() {
		const env = await freshEnv();
		const root = await mkdtemp(join(tmpdir(), "mfw-settings-repo-"));
		const settings = new SettingsService({
			mfwHome: env.home,
			project: "demo",
			root,
			integrationBranch: "main",
			scheduler: env.scheduler,
			brain: env.brain,
			assistance: new FakeAssistance(env.brain),
			mergeQueue: env.mergeQueue,
		});
		return { env, root, settings };
	}

	test("a valid list is persisted and read back; an empty list clears it", async () => {
		const { env, settings, root } = await envWithRepo();
		const view = await settings.update({
			docs: [{ id: "docs", label: "Docs", path: "./docs/" }],
		});
		expect(view.values.docs).toEqual([
			{ id: "docs", label: "Docs", path: "docs" },
		]);
		const stored = await loadConfig(env.home);
		expect(stored.projects.find((p) => p.name === "demo")?.docs).toEqual(
			view.values.docs,
		);
		expect(view.needsRestart).not.toContain("docs");
		expect((await settings.update({ docs: [] })).values.docs).toEqual([]);
		await rm(root, { recursive: true, force: true });
	});

	test("a path that leaves the repository is refused and nothing is written", async () => {
		const { env, settings, root } = await envWithRepo();
		await expect(
			settings.update({ docs: [{ id: "x", label: "X", path: "../outside" }] }),
		).rejects.toThrow(/leaves the repository/);
		const stored = await loadConfig(env.home);
		expect(
			stored.projects.find((p) => p.name === "demo")?.docs,
		).toBeUndefined();
		await rm(root, { recursive: true, force: true });
	});
});
