import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LauncherSteps } from "../../src/containment/agent-launch.ts";
import {
	type EnvRunRequest,
	type EnvRunResult,
	runEnvStep,
} from "../../src/containment/dev-env-build.ts";
import { discoverToolchain } from "../../src/containment/toolchain.ts";
import { git } from "../../src/git.ts";
import { cagedSteps } from "./caged-launch.ts";

/**
 * Fixtures for the dev environment's live tests: a fake home with canaries, an
 * mfw home, a stand-in `systemd-run`, and project repositories under the
 * worktree's `.work`, never in a real home. See caged-launch.ts for what the
 * stand-in does and does not prove.
 */

export const FIXTURES = resolve(
	import.meta.dir,
	"../../../../.work/live-sandbox",
);
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

const BWRAP = Bun.which("bwrap");

/** Null when real bwrap runs here; the reason otherwise. */
export function bwrapSkipReason(): string | null {
	if (process.arch !== "x64") return "seccomp is x86_64 only";
	if (!BWRAP) return "no bwrap";
	const r = Bun.spawnSync([
		BWRAP,
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--",
		"true",
	]);
	return r.exitCode === 0 ? null : "bwrap cannot run here";
}

/** Null when the nix daemon answers and does not trust this user. */
export function nixSkipReason(): string | null {
	if (!existsSync("/nix/var/nix/daemon-socket/socket")) return "no nix daemon";
	const nix = Bun.which("nix");
	if (!nix) return "no nix on PATH";
	const r = Bun.spawnSync(
		[
			nix,
			"--extra-experimental-features",
			"nix-command",
			"store",
			"info",
			"--json",
		],
		{ env: { NIX_REMOTE: "daemon", PATH: process.env.PATH ?? "" } },
	);
	if (r.exitCode !== 0) return "the nix daemon does not answer";
	return /"trusted":(?:false|0)[,}]/.test(r.stdout.toString())
		? null
		: "the nix daemon trusts this user";
}

/**
 * Null when every tool resolves on `path` the way the env build resolves them
 * (the trusted-binary rules of the toolchain, not a bare `which`); otherwise
 * the reason, which names the tool and how to get it. For `liveGate(..., "nix")`.
 * `fixture` points the lookup at a fake root, for tests of this function.
 */
export function toolSkipReason(
	names: readonly string[],
	path: string = process.env.PATH ?? "",
	fixture?: { root: string; home: string },
): string | null {
	const plan = discoverToolchain({
		home: fixture?.home ?? realpathSync(homedir()),
		...(fixture ? { root: fixture.root } : {}),
		binaries: names,
		path,
		// Only the lookup matters here: nothing is bound, so no closure is read.
		closure: () => ({ method: "reference-scan", paths: [] }),
	});
	const absent = plan.unresolved
		.filter((u) => u.reason === "not found on PATH")
		.map((u) => u.name);
	const refused = plan.unresolved.filter(
		(u) => u.reason !== "not found on PATH",
	);
	const pkgs = [
		...new Set([...plan.unresolved.map((u) => u.name), "mise", "direnv"]),
	]
		.map((n) => `nixpkgs#${n}`)
		.join(" ");
	const fix = (what: string) =>
		`add ${what} to your environment (nix shell ${pkgs}, or the repo dev shell) or unset MFW_REQUIRE_LIVE_NIX`;
	const parts: string[] = [];
	if (absent.length > 0) {
		const list =
			absent.length === 1
				? `${absent[0]} is`
				: `${absent.slice(0, -1).join(", ")} and ${absent.at(-1)} are`;
		parts.push(
			`${list} not on PATH: ${fix(absent.length === 1 ? "it" : "them")}`,
		);
	}
	for (const u of refused) {
		parts.push(
			`${u.name} on PATH is not a trusted binary (${u.reason}): ${fix("a trusted one")}`,
		);
	}
	return parts.length > 0 ? parts.join("; ") : null;
}

/** The nixpkgs the repository's own flake is pinned to: already in the store here. */
export function pinnedNixpkgs(): Record<string, unknown> {
	const lock = JSON.parse(readFileSync(join(REPO_ROOT, "flake.lock"), "utf8"));
	return lock.nodes.nixpkgs;
}

/** A one-input flake lock pinned to {@link pinnedNixpkgs}. */
export function flakeLockText(): string {
	return `${JSON.stringify(
		{
			nodes: {
				nixpkgs: pinnedNixpkgs(),
				root: { inputs: { nixpkgs: "nixpkgs" } },
			},
			root: "root",
			version: 7,
		},
		null,
		2,
	)}\n`;
}

/** A devShell holding one package, pinned to the store's nixpkgs. */
export function tinyFlake(packages = "pkgs.hello"): string {
	return [
		"{",
		'  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
		"  outputs = { self, nixpkgs }: let",
		'    pkgs = nixpkgs.legacyPackages."x86_64-linux";',
		"  in {",
		'    devShells."x86_64-linux".default = pkgs.mkShellNoCC {',
		`      packages = [ ${packages} ];`,
		'      FIXTURE_FLAKE = "yes";',
		"    };",
		"  };",
		"}",
		"",
	].join("\n");
}

export interface EnvLab {
	base: string;
	home: string;
	mfwHome: string;
	shim: string;
	canaries: { ssh: string; config: string };
	assertCanaries(): void;
	/** A new committed repository with `files`; returns its root and commit. */
	repo(
		name: string,
		files: Record<string, string>,
	): Promise<{ root: string; commit: string }>;
	/**
	 * Run one env step in the caged chain. Rejects, naming the phase it was in,
	 * if the step has not returned 30 s after its own deadline: a deadline that
	 * does not stop the run fails the test fast with a diagnosis instead of
	 * running into the test runner's timeout.
	 */
	run(
		root: string,
		commit: string,
		req: Partial<EnvRunRequest> & Pick<EnvRunRequest, "step" | "allow">,
	): Promise<EnvRunResult>;
	dispose(): void;
}

export function createEnvLab(label: string): EnvLab {
	mkdirSync(FIXTURES, { recursive: true });
	const base = realpathSync(mkdtempSync(join(FIXTURES, `${label}-`)));
	const home = join(base, "home");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(join(home, ".config"), { recursive: true });
	const canaries = {
		ssh: join(home, ".ssh/id_canary"),
		config: join(home, ".config/keep"),
	};
	writeFileSync(canaries.ssh, "canary-key\n");
	writeFileSync(canaries.config, "keep\n");
	const mfwHome = join(base, "mfw");
	mkdirSync(mfwHome);
	const shim = join(base, "systemd-run-shim");
	writeFileSync(
		shim,
		'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do a="$1"; shift; [ "$a" = "--" ] && break; done\nexec "$@"\n',
	);
	chmodSync(shim, 0o755);
	const caged = cagedSteps({ home, path: process.env.PATH ?? "", shim });
	// Which launcher step the current run is in, for the guard's message.
	let phase = "idle";
	let phaseSince = Date.now();
	const enter = (p: string) => {
		phase = p;
		phaseSince = Date.now();
	};
	const steps: LauncherSteps = {
		compileHost: async (...a) => {
			enter("compileHost");
			const r = await caged.compileHost(...a);
			enter("after compileHost (compile, probe next)");
			return r;
		},
		attest: async (...a) => {
			enter("attest (the sandbox probe)");
			const r = await caged.attest(...a);
			enter("after attest (gate next)");
			return r;
		},
		authorize: async (...a) => {
			enter("authorize (the gate)");
			return caged.authorize(...a);
		},
		launch: (...a) => {
			enter(
				"launch: the step is running, waiting for it to exit and close its output",
			);
			const child = caged.launch(...a);
			void child.exited.then((code) =>
				enter(
					`cleanup: the step exited ${code} (proxy stop, egress record, clone removal)`,
				),
			);
			return child;
		},
	};
	return {
		base,
		home,
		mfwHome,
		shim,
		canaries,
		assertCanaries() {
			if (readFileSync(canaries.ssh, "utf8") !== "canary-key\n") {
				throw new Error("the ssh canary changed");
			}
			if (readFileSync(canaries.config, "utf8") !== "keep\n") {
				throw new Error("the config canary changed");
			}
		},
		async repo(name, files) {
			const root = join(base, name);
			mkdirSync(join(root, ".mfw"), { recursive: true });
			await git(["init", "-q", "-b", "main", "."], root);
			await git(["config", "user.email", "t@t"], root);
			await git(["config", "user.name", "t"], root);
			writeFileSync(join(root, ".gitignore"), ".mfw/\n");
			for (const [rel, text] of Object.entries(files)) {
				mkdirSync(dirname(join(root, rel)), { recursive: true });
				writeFileSync(join(root, rel), text);
			}
			await git(["add", "-A"], root);
			await git(["commit", "-q", "-m", "fixture"], root);
			const commit = (await git(["rev-parse", "HEAD"], root)).stdout;
			return { root, commit };
		},
		async run(root, commit, req) {
			const full: EnvRunRequest = {
				projectRoot: root,
				stateDir: join(root, ".mfw"),
				mfwHome,
				commit,
				dataDir: join(mfwHome, "env", "data", "lab"),
				// Under the suite's 300 s test timeout, with room for the guard.
				timeoutMs: 240_000,
				steps,
				...req,
			};
			enter("clone and proxy start");
			const started = Date.now();
			let guard: ReturnType<typeof setTimeout> | undefined;
			const stuck = new Promise<never>((_, reject) => {
				guard = setTimeout(() => {
					reject(
						new Error(
							`the ${full.step} step did not return ${Math.round((Date.now() - started) / 1000)} s after it started (deadline ${Math.round(full.timeoutMs / 1000)} s): stuck in ${phase} for ${Math.round((Date.now() - phaseSince) / 1000)} s`,
						),
					);
				}, full.timeoutMs + 30_000);
			});
			try {
				return await Promise.race([runEnvStep(full), stuck]);
			} finally {
				clearTimeout(guard);
				enter("idle");
			}
		},
		dispose() {
			rmSync(base, { recursive: true, force: true });
		},
	};
}
