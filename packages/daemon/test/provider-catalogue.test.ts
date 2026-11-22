import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor } from "../src/agents/adapter.ts";
import {
	CURSOR_AGENT_IDENTITY,
	PI_IDENTITY,
} from "../src/agents/agent-identity.ts";
import {
	catalogueCredentialIds,
	DEFAULT_PROVIDER_ID,
	drivableProviders,
	findProvider,
	MODEL_LIST_IS_A_HINT,
	MODEL_SNAPSHOT_CHECKED,
	PROVIDER_CATALOGUE,
	providerConfigFor,
	tierModel,
} from "../src/agents/catalogue.ts";
import { ProviderDetector, probeAuth, whichBin } from "../src/agents/detect.ts";
import { CredentialStore } from "../src/credentials.ts";
import { ProviderSettings } from "../src/settings.ts";

const dirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

/** A real executable that prints `text`, exercises the actual spawn path. */
async function fakeBin(dir: string, name: string, text: string): Promise<void> {
	const path = join(dir, name);
	await writeFile(path, `#!/bin/sh\necho '${text}'\n`);
	await chmod(path, 0o755);
}

afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("catalogue", () => {
	test("every entry either has an adapter or says why it does not", () => {
		expect(PROVIDER_CATALOGUE.length).toBeGreaterThan(0);
		const ids = PROVIDER_CATALOGUE.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);

		for (const entry of PROVIDER_CATALOGUE) {
			expect(entry.bin.length).toBeGreaterThan(0);
			expect(entry.versionArgs.length).toBeGreaterThan(0);
			expect(entry.auth.length).toBeGreaterThan(0);
			if (entry.drivable) {
				expect(entry.configType).toBeDefined();
				// A provider a picker may offer must come with models to pick.
				expect(entry.models.length).toBeGreaterThan(0);
				expect(entry.models.some((m) => m.id === entry.defaultModel)).toBe(
					true,
				);
			} else {
				expect(entry.configType).toBeUndefined();
				// The honesty rule: no silent "unsupported", it says why.
				expect(entry.unsupportedReason?.length ?? 0).toBeGreaterThan(0);
				// Nothing can verify a model list for a CLI mfw cannot launch,
				// so it must not ship a guessed one.
				expect(entry.models).toEqual([]);
			}
			// Every drivable entry must resolve to a real adapter.
			if (entry.drivable) expect(adapterFor(entry.id)).toBeDefined();
		}
	});

	test("Claude, Codex and the ACP agents are drivable, and Claude remains the default", () => {
		expect(drivableProviders().map((p) => p.id)).toEqual([
			"claude-cli",
			"codex-cli",
			"gemini-cli",
			"cursor-agent",
			"opencode",
			"pi",
		]);
		expect(findProvider(DEFAULT_PROVIDER_ID)?.drivable).toBe(true);
	});

	test("Codex offers every current GPT-5.6 tier", () => {
		const codex = findProvider("codex-cli");
		expect(codex?.models.map((model) => model.id)).toEqual([
			"gpt-5.6",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
	});

	test("claude models lead with aliases, which cannot go stale", () => {
		const claude = findProvider("claude-cli");
		if (!claude) throw new Error("claude-cli missing from the catalogue");
		expect(claude.models[0]?.kind).toBe("alias");
		const aliases = claude.models
			.filter((m) => m.kind === "alias")
			.map((m) => m.id);
		expect(aliases).toContain("sonnet");
		expect(aliases).toContain("opus");
		// The default model the engine ships with must be offerable.
		expect(aliases).toContain("sonnet");
		// Pinned ids exist too, and are flagged as the perishable kind.
		expect(claude.models.some((m) => m.kind === "pinned")).toBe(true);
		expect(claude.modelsAreSnapshot).toBe(true);
		expect(MODEL_SNAPSHOT_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// The list never becomes a gate.
		expect(MODEL_LIST_IS_A_HINT).toBe(true);
	});

	test("providerConfigFor resolves the drivable and refuses the rest", () => {
		expect(providerConfigFor("claude-cli")).toEqual({
			id: "claude-cli",
			type: "claude-cli",
		});
		expect(providerConfigFor("claude-cli", { FOO: "1" })).toEqual({
			id: "claude-cli",
			type: "claude-cli",
			env: { FOO: "1" },
		});
		expect(providerConfigFor("codex-cli")).toEqual({
			id: "codex-cli",
			type: "codex-cli",
		});
		for (const id of ["gemini-cli", "cursor-agent", "opencode", "pi"]) {
			expect(providerConfigFor(id)).toEqual({ id, type: "acp" });
		}
		expect(() => providerConfigFor("nope")).toThrow(/unknown provider/);
	});

	test("ACP agents offer only their own default model", () => {
		for (const id of ["gemini-cli", "cursor-agent", "opencode", "pi"]) {
			const entry = findProvider(id);
			expect(entry?.models).toEqual([
				{ id: "default", label: "Agent default", kind: "alias" },
			]);
			expect(entry?.defaultModel).toBe("default");
			expect(entry?.tiers).toBeUndefined();
		}
		const cursor = findProvider("cursor-agent");
		expect(
			cursor?.auth.some((a) => a.envVars?.includes("CURSOR_API_KEY")),
		).toBe(true);
	});

	test("Cursor is found as `agent` and pi as `pi`, each with an identity check", () => {
		const cursor = findProvider("cursor-agent");
		expect(cursor?.bin).toBe("agent");
		expect(cursor?.identity).toBe(CURSOR_AGENT_IDENTITY);
		const pi = findProvider("pi");
		expect(pi).toMatchObject({
			id: "pi",
			bin: "pi",
			drivable: true,
			configType: "acp",
			acceptsEndpoints: true,
			modelsAreSnapshot: false,
			defaultModel: "default",
		});
		expect(pi?.identity).toBe(PI_IDENTITY);
		expect(pi?.auth[0]?.loginFiles).toEqual([
			".pi/agent/auth.json",
			".pi/agent/models.json",
		]);
		expect(pi?.tiers).toBeUndefined();
	});

	test("credential ids are collected for the extra-credentials diff", () => {
		expect(catalogueCredentialIds()).toContain("anthropic");
	});

	test("model tiers are set for the drivable providers, as aliases where the CLI has one", () => {
		const claude = findProvider("claude-cli");
		expect(claude?.tiers).toEqual({
			light: "haiku",
			standard: "sonnet",
			strong: "opus",
		});
		for (const id of Object.values(claude?.tiers ?? {})) {
			expect(
				claude?.models.some((m) => m.id === id && m.kind === "alias"),
			).toBe(true);
		}

		const codex = findProvider("codex-cli");
		expect(codex?.tiers).toEqual({
			light: "gpt-5.6-luna",
			standard: "gpt-5.6-terra",
			strong: "gpt-5.6-sol",
		});
		for (const id of Object.values(codex?.tiers ?? {})) {
			expect(codex?.models.some((m) => m.id === id)).toBe(true);
		}
	});

	test("tierModel resolves a provider's tier and is undefined for anything unknown", () => {
		expect(tierModel("claude-cli", "light")).toBe("haiku");
		expect(tierModel("claude-cli", "standard")).toBe("sonnet");
		expect(tierModel("claude-cli", "strong")).toBe("opus");
		expect(tierModel("codex-cli", "strong")).toBe("gpt-5.6-sol");
		// ACP agents have no tiers: routing falls back to the project model.
		expect(tierModel("gemini-cli", "light")).toBeUndefined();
		expect(tierModel("nope", "light")).toBeUndefined();
	});
});

describe("detection", () => {
	test("finds an executable on PATH and ignores a non-executable file", async () => {
		const dir = await tmp("mfw-detect-");
		await fakeBin(dir, "toolish", "v1.2.3");
		await writeFile(join(dir, "notexec"), "#!/bin/sh\n");

		const env = { PATH: dir } as NodeJS.ProcessEnv;
		expect(await whichBin("toolish", env)).toBe(join(dir, "toolish"));
		expect(await whichBin("notexec", env)).toBeNull();
		expect(await whichBin("absent", env)).toBeNull();
		// No PATH at all is a normal state, not an error.
		expect(await whichBin("toolish", {} as NodeJS.ProcessEnv)).toBeNull();
	});

	test("asks the tool for its version rather than assuming one", async () => {
		const dir = await tmp("mfw-detect-");
		await fakeBin(dir, "claude", "9.9.9 (Claude Code)");
		const detector = new ProviderDetector({ env: { PATH: dir } });
		const d = await detector.detect(
			findProvider("claude-cli") as (typeof PROVIDER_CATALOGUE)[number],
		);
		expect(d).toMatchObject({
			id: "claude-cli",
			installed: true,
			path: join(dir, "claude"),
			version: "9.9.9 (Claude Code)",
		});
	});

	test("a machine with none of the CLIs reports not-found, never throws", async () => {
		const empty = await tmp("mfw-detect-empty-");
		const detector = new ProviderDetector({ env: { PATH: empty } });
		const all = await detector.detectAll(PROVIDER_CATALOGUE);
		expect(all.size).toBe(PROVIDER_CATALOGUE.length);
		for (const entry of PROVIDER_CATALOGUE) {
			expect(all.get(entry.id)).toEqual({
				id: entry.id,
				installed: false,
				path: null,
				version: null,
			});
		}
	});

	test("a present binary whose --version fails is still installed", async () => {
		const dir = await tmp("mfw-detect-");
		const path = join(dir, "claude");
		await writeFile(path, "#!/bin/sh\necho 'bad flag' >&2\nexit 2\n");
		await chmod(path, 0o755);
		const detector = new ProviderDetector({ env: { PATH: dir } });
		const d = await detector.detect(
			findProvider("claude-cli") as (typeof PROVIDER_CATALOGUE)[number],
		);
		expect(d.installed).toBe(true);
		expect(d.version).toBeNull();
		expect(d.versionError).toContain("bad flag");
	});

	test("Cursor's `agent` counts only when it resolves to a cursor-agent binary", async () => {
		const entry = findProvider(
			"cursor-agent",
		) as (typeof PROVIDER_CATALOGUE)[number];
		// Genuine layout: agent is a link to .../versions/<v>/cursor-agent.
		const good = await tmp("mfw-detect-cursor-");
		await mkdir(join(good, "share"), { recursive: true });
		await fakeBin(join(good, "share"), "cursor-agent", "2026.05.01-abc");
		await mkdir(join(good, "bin"));
		await symlink(
			join(good, "share", "cursor-agent"),
			join(good, "bin", "agent"),
		);
		const ok = await new ProviderDetector({
			env: { PATH: join(good, "bin") },
		}).detect(entry);
		expect(ok).toMatchObject({ installed: true, version: "2026.05.01-abc" });
		expect(ok.identityError).toBeUndefined();

		// Some other tool called `agent`.
		const bad = await tmp("mfw-detect-agent-");
		await fakeBin(bad, "agent", "1.0");
		const refused = await new ProviderDetector({
			env: { PATH: bad },
		}).detect(entry);
		expect(refused).toMatchObject({
			installed: false,
			path: join(bad, "agent"),
			version: null,
		});
		expect(refused.identityError).toContain("not Cursor's CLI");
	});

	test("pi counts only when `pi --help` names the pi coding agent", async () => {
		const entry = findProvider("pi") as (typeof PROVIDER_CATALOGUE)[number];
		const dir = await tmp("mfw-detect-pi-");
		await fakeBin(dir, "pi", "1.5.2");
		const seen: string[][] = [];
		const make = (text: string) =>
			new ProviderDetector({
				env: { PATH: dir },
				probeIdentity: async (_p, args) => {
					seen.push([...args]);
					return { ok: true, text };
				},
			});
		const ok = await make(
			"pi - AI coding assistant with read, bash, edit, write tools",
		).detect(entry);
		expect(ok).toMatchObject({ installed: true, version: "1.5.2" });
		expect(seen).toEqual([["--help"]]);
		const bad = await make("pi: the irrational number calculator").detect(
			entry,
		);
		expect(bad).toMatchObject({ installed: false, path: join(dir, "pi") });
		expect(bad.identityError).toContain("not the pi coding agent");
		// A probe that cannot run fails closed.
		const broken = await new ProviderDetector({
			env: { PATH: dir },
			probeIdentity: async () => {
				throw new Error("boom");
			},
		}).detect(entry);
		expect(broken.installed).toBe(false);
		expect(broken.identityError).toBeDefined();
	});

	test("caches within the TTL and re-probes after it", async () => {
		let clock = 1_000;
		let probes = 0;
		const dir = await tmp("mfw-detect-");
		await fakeBin(dir, "claude", "1.0.0");
		const detector = new ProviderDetector({
			env: { PATH: dir },
			now: () => clock,
			ttlMs: 500,
			probeVersion: async () => {
				probes++;
				return { ok: true, text: "1.0.0" };
			},
		});
		const entry = findProvider(
			"claude-cli",
		) as (typeof PROVIDER_CATALOGUE)[number];
		await detector.detect(entry);
		await detector.detect(entry);
		expect(probes).toBe(1);
		clock += 600;
		await detector.detect(entry);
		expect(probes).toBe(2);
	});
});

describe("auth probing", () => {
	const claude = () =>
		findProvider("claude-cli") as (typeof PROVIDER_CATALOGUE)[number];

	test("a Claude OAuth credentials file counts as a subscription", async () => {
		const home = await tmp("mfw-home-");
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(
			join(home, ".claude", ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { accessToken: "x" } }),
		);
		const [sub, key] = await probeAuth(claude(), {
			home,
			env: {} as NodeJS.ProcessEnv,
		});
		expect(sub).toMatchObject({ kind: "subscription", configured: true });
		expect(key).toMatchObject({
			kind: "api-key",
			credentialId: "anthropic",
			configured: false,
			via: null,
		});
	});

	test("login detection is presence only: an unreadable file counts, an empty or missing one does not", async () => {
		const home = await tmp("mfw-home-");
		await mkdir(join(home, ".claude"), { recursive: true });
		const file = join(home, ".claude", ".credentials.json");
		let [sub] = await probeAuth(claude(), { home, env: {} });
		expect(sub?.configured).toBe(false);

		await writeFile(file, "");
		[sub] = await probeAuth(claude(), { home, env: {} });
		expect(sub?.configured).toBe(false);

		// Contents are never opened: mode 000 and garbage still count as present.
		await writeFile(file, "{{{ not json", { mode: 0o000 });
		[sub] = await probeAuth(claude(), { home, env: {} });
		expect(sub).toMatchObject({ configured: true, via: file });
	});

	test("a stored key or an env var satisfies the api-key method", async () => {
		const home = await tmp("mfw-home-");
		const stored = await probeAuth(claude(), {
			home,
			env: {},
			hasCredential: async (id) => id === "anthropic",
		});
		expect(stored[1]).toMatchObject({
			configured: true,
			via: "credentials.json:anthropic",
		});

		const fromEnv = await probeAuth(claude(), {
			home,
			env: { ANTHROPIC_API_KEY: "sk-x" } as NodeJS.ProcessEnv,
		});
		expect(fromEnv[1]).toMatchObject({
			configured: true,
			via: "$ANTHROPIC_API_KEY",
		});
	});
});

describe("ProviderSettings.catalogue", () => {
	test("returns a pickable list joined with this machine's reality", async () => {
		const home = await tmp("mfw-home-");
		const binDir = await tmp("mfw-bin-");
		await fakeBin(binDir, "claude", "2.1.224 (Claude Code)");

		const store = CredentialStore.at(home);
		await store.set("anthropic", "sk-secret-value");
		await store.set("openrouter", "sk-hand-rolled");

		const providers = new ProviderSettings(store, {
			home,
			env: { PATH: binDir } as NodeJS.ProcessEnv,
			detector: new ProviderDetector({ env: { PATH: binDir } }),
		});
		const view = await providers.catalogue();

		expect(view.selectableProviderIds).toEqual([
			"claude-cli",
			"codex-cli",
			"gemini-cli",
			"cursor-agent",
			"opencode",
			"pi",
		]);
		expect(view.allowsCustomModel).toBe(true);
		expect(view.modelSnapshotCheckedOn).toBe(MODEL_SNAPSHOT_CHECKED);

		const claude = view.providers.find((p) => p.id === "claude-cli");
		expect(claude).toMatchObject({
			drivable: true,
			installed: true,
			version: "2.1.224 (Claude Code)",
		});
		expect(claude?.models.length).toBeGreaterThan(0);
		expect(claude?.auth.map((a) => a.kind)).toEqual([
			"subscription",
			"api-key",
		]);
		// The stored key is reflected as presence, and only as presence.
		expect(claude?.auth[1]).toMatchObject({ configured: true });

		// Codex is selectable even when this machine has not installed it yet;
		// detection and protocol support are separate facts.
		const codex = view.providers.find((p) => p.id === "codex-cli");
		expect(codex?.drivable).toBe(true);
		expect(codex?.defaultModel).toBe("gpt-5.6-sol");
		expect(codex?.models.length).toBeGreaterThan(0);
		expect(codex?.installed).toBe(false);

		// A hand-added credential the catalogue does not know stays visible.
		expect(view.extraCredentials).toEqual([{ id: "openrouter", hasKey: true }]);

		// Nothing in the whole view can carry a key.
		expect(JSON.stringify(view)).not.toContain("sk-secret-value");
		expect(JSON.stringify(view)).not.toContain("sk-hand-rolled");
	});
});
