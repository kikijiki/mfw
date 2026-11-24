import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	type AgentLaunchRequest,
	launchAgentSandbox,
} from "../src/containment/agent-launch.ts";
import { TEMPORARY_FLEET_WRITABLE } from "../src/containment/agent-profile.ts";
import { createCheckSandbox } from "../src/containment/check-sandbox.ts";
import { runEnvCommand } from "../src/containment/dev-env-cli.ts";
import { seedDeps } from "../src/containment/dev-env-deps.ts";
import {
	type DevEnvResolution,
	resolveDevEnv,
} from "../src/containment/dev-env-resolve.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { git } from "../src/git.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";
import { verifyInClone } from "../src/verifier.ts";
import { cagedSteps } from "./support/caged-launch.ts";
import {
	bwrapSkipReason,
	createEnvLab,
	type EnvLab,
	nixSkipReason,
} from "./support/dev-env-fixture.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * mfw is its own first customer: this repository's own environment (its
 * `.envrc` with `use flake`, its flake devShell, and `bun install` from its
 * lockfile) allowed with `mfw env allow`, evaluated and installed with `mfw env
 * build` in the env-build and env-install sandboxes, then given to a fake agent
 * in the task role and to DoD checks in the verifier role. Real bwrap, the
 * host's nix daemon, the npm registry; the systemd layer is a stand-in
 * (caged-launch.ts), so the task and memory limits are not exercised here.
 */

const REPO = resolve(import.meta.dir, "../../..");

const skip =
	liveGate("dev-env-mfw-live", bwrapSkipReason()) ??
	liveGate("dev-env-mfw-live", nixSkipReason(), "nix");

describe.skipIf(skip !== null)("mfw on mfw", () => {
	let lab: EnvLab;
	let root: string;
	let commit: string;
	let handle: ProjectDbHandle;
	let bin: string;
	const out: string[] = [];
	const err: string[] = [];
	const steps = () =>
		cagedSteps({
			home: lab.home,
			path: [bin, process.env.PATH ?? ""].join(":"),
			shim: lab.shim,
		});
	const cli = (...args: string[]) =>
		runEnvCommand(args, {
			home: lab.mfwHome,
			out: (l) => out.push(l),
			err: (l) => err.push(l),
			seams: { steps: steps() },
		});
	const env = (): Promise<DevEnvResolution> =>
		resolveDevEnv({
			mfwHome: lab.mfwHome,
			project: "mfw",
			root,
			config: { setup: ["bun install --frozen-lockfile"], nixDaemon: true },
			rev: "main",
			build: false,
		});
	const clones = (checkRunner?: ReturnType<typeof createCheckSandbox>) =>
		new VerifierClones({
			workspaceRoot: join(lab.mfwHome, "workspaces"),
			primaryRoot: root,
			...(checkRunner ? { checkRunner } : {}),
			prepareTree: async (tree) => {
				const r = await env();
				if (r.kind === "ready" && r.deps) await seedDeps(tree, r.deps);
			},
		});

	beforeAll(async () => {
		lab = createEnvLab("mfw-on-mfw");
		root = join(lab.base, "mfw-project");
		mkdirSync(root);
		// The committed tree of this checkout, as a fresh repository: tracked files only.
		const archive = Bun.spawnSync([
			"git",
			"-C",
			REPO,
			"archive",
			"--format=tar",
			"HEAD",
		]);
		if (archive.exitCode !== 0) throw new Error("git archive failed");
		const untar = Bun.spawnSync(["tar", "-x", "-C", root], {
			stdin: archive.stdout,
		});
		if (untar.exitCode !== 0) throw new Error("tar failed");
		await git(["init", "-q", "-b", "main", "."], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "mfw"], root);
		commit = (await git(["rev-parse", "HEAD"], root)).stdout;
		mkdirSync(join(root, ".mfw"), { recursive: true });
		handle = await openProjectDb(join(root, ".mfw"));
		writeFileSync(
			join(lab.mfwHome, "config.json"),
			JSON.stringify({
				projects: [
					{
						name: "mfw",
						root,
						integrationBranch: "main",
						runWorkspace: "clone",
						env: { setup: ["bun install --frozen-lockfile"], nixDaemon: true },
					},
				],
			}),
		);
		for (const rel of TEMPORARY_FLEET_WRITABLE.claude) {
			mkdirSync(join(lab.mfwHome, "agents/claude", rel), { recursive: true });
		}
		bin = join(lab.home, ".local/bin");
		mkdirSync(bin, { recursive: true });
	}, 120_000);
	afterAll(() => {
		handle?.close();
		lab?.dispose();
	});

	test("mfw env allow approves its .envrc, flake and lockfile, and nothing runs yet", async () => {
		expect(await cli("status", "mfw")).toBe(1);
		expect(out.join("\n")).toContain("env_not_approved");
		expect(await cli("allow", "mfw")).toBe(0);
		const text = out.join("\n");
		expect(text).toContain(`direnv environment of mfw at ${commit}`);
		for (const f of [
			".envrc",
			"flake.nix",
			"flake.lock",
			"bun.lock",
			"package.json",
		]) {
			expect(text).toMatch(
				new RegExp(`\\n  ${f.replace(".", "\\.")}  sha256:[0-9a-f]{64}`),
			);
		}
		expect(existsSync(join(lab.mfwHome, "env/cache"))).toBe(false);
	});

	test("mfw env build evaluates the devShell and installs node_modules in their sandboxes", async () => {
		out.length = 0;
		const code = await cli("build", "mfw");
		if (code !== 0) console.log(out.join("\n"), err.join("\n"));
		expect(code).toBe(0);
		const r = await env();
		expect(r.kind).toBe("ready");
		if (r.kind !== "ready") return;
		expect(r.capture.source).toBe("direnv");
		expect(r.capture.path.some((p) => /-bun-[^/]+\/bin$/.test(p))).toBe(true);
		expect(r.capture.path.some((p) => /-sqlite-[^/]+\/bin$/.test(p))).toBe(
			true,
		);
		expect(r.capture.watches).toEqual([".envrc", "flake.lock", "flake.nix"]);
		expect(r.deps?.outputs).toContain("node_modules");
		expect(r.deps?.egress.allowed).toEqual(["registry.npmjs.org:443"]);
		// The primary never ran any of it.
		expect(existsSync(join(root, "node_modules"))).toBe(false);
		expect(existsSync(join(root, ".direnv"))).toBe(false);
		lab.assertCanaries();
	}, 590_000);

	test("a fake agent task gets the devShell and the dependencies", async () => {
		const r = await env();
		if (r.kind !== "ready") throw new Error("not ready");
		const clone = await clones().create(commit, "task");
		try {
			const runId = "mfw-task-1";
			const stateDir = join(root, ".mfw");
			const runDir = join(stateDir, "runs", runId);
			ensureRunDirLayout(runDir);
			const agent = join(bin, "claude");
			writeFileSync(
				agent,
				[
					"#!/bin/sh",
					'[ "$HOME" = /sandbox/agent ] || exit 99',
					`[ ! -e '${lab.home}/.ssh' ] || exit 99`,
					"bun --version > /work/agent-bun",
					"sqlite3 --version > /work/agent-sqlite",
					"test -d node_modules/typescript && echo yes > /work/agent-deps",
					"exit 0",
					"",
				].join("\n"),
			);
			chmodSync(agent, 0o755);
			const req: AgentLaunchRequest = {
				version: 1,
				runId,
				role: "task",
				approvalMode: "autonomous",
				cli: "claude",
				tree: clone.path,
				runDir,
				projectRoot: root,
				stateDir,
				mfwHome: lab.mfwHome,
				env: { MFW_RUN_ID: runId },
				secretNames: [],
				devEnv: { fingerprint: r.fingerprint },
			};
			const launched = await launchAgentSandbox(req, ["claude"], {
				...steps(),
				db: handle.db,
				secretValue: () => undefined,
				warn: () => {},
			});
			if (!launched.ok) throw new Error(`${launched.code}: ${launched.reason}`);
			(launched.child.stdin as unknown as { end(): void }).end();
			await Promise.all([
				new Response(launched.child.stdout as never).text(),
				new Response(launched.child.stderr as never).text(),
				launched.child.exited,
			]);
			expect(readFileSync(join(clone.path, "agent-bun"), "utf8")).toMatch(
				/^1\.\d+\.\d+/,
			);
			expect(readFileSync(join(clone.path, "agent-sqlite"), "utf8")).toMatch(
				/^3\./,
			);
			expect(readFileSync(join(clone.path, "agent-deps"), "utf8").trim()).toBe(
				"yes",
			);
		} finally {
			await clone.dispose();
		}
		lab.assertCanaries();
	}, 300_000);

	test("its checks pass in the verifier role, with checkPrefix nix develop -c", async () => {
		const runner = createCheckSandbox({
			db: handle.db,
			mfwHome: lab.mfwHome,
			projectRoot: root,
			stateDir: join(root, ".mfw"),
			steps: steps(),
			devEnv: env,
		});
		const v = await verifyInClone(
			clones(runner),
			commit,
			"mfw",
			{
				verifier: "deterministic",
				checks: [
					{ run: "bun --version" },
					{ run: "sqlite3 --version" },
					{ run: "bunx tsc --version" },
				],
			} as never,
			commit,
			{ checkPrefix: "nix develop -c" },
		);
		for (const c of v.checks) expect(c.detail).toBeUndefined();
		expect(v.passed).toBe(true);
	}, 300_000);
});
