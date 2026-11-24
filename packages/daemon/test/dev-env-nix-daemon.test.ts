import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EnvRunRequest,
	EnvRunResult,
} from "../src/containment/dev-env-build.ts";
import { runEnvStep } from "../src/containment/dev-env-build.ts";
import {
	describeEnvCard,
	envReachStatement,
} from "../src/containment/dev-env-card.ts";
import { runEnvCommand } from "../src/containment/dev-env-cli.ts";
import { resolveDevEnv } from "../src/containment/dev-env-resolve.ts";
import { envrcUsesNix } from "../src/containment/dev-env-sources.ts";
import { allowEnv, EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";

/**
 * F1 of the P8 security review: the nix daemon acts outside the proxy, so it
 * is an explicit per-project opt-in, its build sandbox must be on, the store
 * must have room, and what the owner reads says all of it.
 */

let base: string;
let mfwHome: string;
const ran: EnvRunRequest[] = [];
const fakeRun = async (req: EnvRunRequest): Promise<EnvRunResult> => {
	ran.push(req);
	return {
		ok: true,
		output: Buffer.from(req.step === "flake" ? '{"variables":{}}' : "{}"),
		log: "",
		egress: null,
		sandboxPath: [],
		sandboxEnv: {},
	};
};

async function project(name: string, files: Record<string, string>) {
	const root = join(base, name);
	mkdirSync(root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	for (const [p, t] of Object.entries(files)) writeFileSync(join(root, p), t);
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "c"], root);
	return { root, commit: (await git(["rev-parse", "HEAD"], root)).stdout };
}

const resolveFor = async (
	root: string,
	commit: string,
	config: Record<string, unknown>,
) => {
	await allowEnv(new EnvTrustStore(mfwHome), {
		project: "p",
		root,
		commit,
		setting: "auto",
		config,
		via: "cli",
	});
	return resolveDevEnv({
		mfwHome,
		project: "p",
		root,
		config,
		rev: "main",
		build: true,
		seams: {
			run: fakeRun,
			closure: () => ({ method: "nix-store", paths: [] }),
			gcRoots: async () => true,
		},
	});
};

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-nixd-")));
	mfwHome = join(base, "mfw");
	mkdirSync(mfwHome);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("the nix daemon is an explicit opt-in", () => {
	test("a flake project without env.nixDaemon is refused with the honest fix, and nothing runs", async () => {
		const { root, commit } = await project("flake", { "flake.nix": "{}\n" });
		const r = await resolveFor(root, commit, {});
		expect(r.kind === "refused" && r.code).toBe("env_unsupported");
		expect(r.kind === "refused" && r.fix).toContain('"nixDaemon": true');
		expect(r.kind === "refused" && r.fix).toContain("outside the proxy");
		expect(r.kind === "refused" && r.fix).toContain("loopback");
		expect(ran.length).toBe(0);
	});

	test("an .envrc that uses nix is refused without it; a plain one runs with no daemon", async () => {
		const nix = await project("envrc-nix", { ".envrc": "use flake\n" });
		expect((await resolveFor(nix.root, nix.commit, {})).kind).toBe("refused");
		expect(ran.length).toBe(0);
		const plain = await project("envrc-plain", { ".envrc": "export A=1\n" });
		expect((await resolveFor(plain.root, plain.commit, {})).kind).toBe("ready");
		expect(ran.at(-1)?.nixDaemon).toBe(false);
		const opted = await project("envrc-opt", { ".envrc": "use flake\n" });
		expect(
			(await resolveFor(opted.root, opted.commit, { nixDaemon: true })).kind,
		).toBe("ready");
		expect(ran.at(-1)?.nixDaemon).toBe(true);
	});

	test("the heuristic finds the common forms", () => {
		for (const t of [
			"use flake",
			"use nix",
			"  use devenv .",
			'eval "$(nix print-dev-env)"',
			"x=$(nix-shell --run env)",
		]) {
			expect([t, envrcUsesNix(t)]).toEqual([t, true]);
		}
		for (const t of ["export NIXPKGS=1", "PATH_add bin", "dotenv"]) {
			expect([t, envrcUsesNix(t)]).toEqual([t, false]);
		}
	});
});

describe("refusals on the host before anything runs", () => {
	const req = (over: Partial<EnvRunRequest>): EnvRunRequest => ({
		step: "flake",
		projectRoot: base,
		stateDir: join(base, ".mfw"),
		mfwHome,
		commit: "0".repeat(40),
		allow: [],
		timeoutMs: 1000,
		nixDaemon: true,
		nixTrust: async () => "untrusted",
		nixSandbox: async () => "true",
		storeFree: () => 100 * 1024 ** 3,
		steps: {
			compileHost: async () => {
				throw new Error("must not be reached");
			},
		} as never,
		...over,
	});

	test("a flake step without the opt-in", async () => {
		const r = await runEnvStep(req({ nixDaemon: false }));
		expect(!r.ok && r.code).toBe("nix_not_allowed");
	});

	test("a daemon whose build sandbox is not true", async () => {
		for (const v of ["false", "relaxed", "unknown"]) {
			const r = await runEnvStep(req({ nixSandbox: async () => v }));
			expect([v, !r.ok && r.code]).toEqual([v, "nix_sandbox_off"]);
		}
	});

	test("a store with less free space than the floor", async () => {
		const r = await runEnvStep(req({ storeFree: () => 100 * 1024 * 1024 }));
		expect(!r.ok && r.code).toBe("store_full");
	});
});

describe("what the owner reads", () => {
	test("with the daemon: outside the proxy, loopback, the whole store, GC", () => {
		const t = envReachStatement("flake", true);
		for (const w of [
			"OUTSIDE the proxy",
			"loopback",
			"whole Nix store",
			"collect store paths",
		]) {
			expect(t).toContain(w);
		}
		const card = describeEnvCard({
			project: "p",
			commit: "c".repeat(40),
			source: "flake",
			files: [],
			configHash: "h",
			nixDaemon: true,
		});
		expect(card.detail).toStartWith("NIX DAEMON: ON.");
		expect(card.detail).not.toContain("(network only through its proxy)");
		expect(envReachStatement("mise", false)).toContain("no nix daemon");
	});

	test("mfw env allow prints the opt-in and the statement", async () => {
		const { root } = await project("cli", { "flake.nix": "{}\n" });
		writeFileSync(
			join(mfwHome, "config.json"),
			JSON.stringify({
				projects: [
					{
						name: "cli",
						root,
						integrationBranch: "main",
						env: { nixDaemon: true },
					},
				],
			}),
		);
		const out: string[] = [];
		await runEnvCommand(["allow", "cli", "--yes"], {
			home: mfwHome,
			out: (l) => out.push(l),
			err: () => {},
		});
		const text = out.join("\n");
		expect(text).toContain("nix daemon: ON");
		expect(text).toContain("OUTSIDE the proxy");
	});
});
