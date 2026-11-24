import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { createCheckSandbox } from "../src/containment/check-sandbox.ts";
import {
	type EnvRunRequest,
	runEnvStep,
} from "../src/containment/dev-env-build.ts";
import {
	type ResolveDevEnvInput,
	resolveDevEnv,
} from "../src/containment/dev-env-resolve.ts";
import { allowEnv, EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";
import { verifyInClone } from "../src/verifier.ts";
import { cagedSteps } from "./support/caged-launch.ts";
import {
	bwrapSkipReason,
	createEnvLab,
	type EnvLab,
	flakeLockText,
	nixSkipReason,
	tinyFlake,
} from "./support/dev-env-fixture.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * The approved environment applied to DoD checks in the verifier role, under
 * real bwrap: evaluated once in the env-build sandbox, cached, then bound
 * read-only into each check with nothing evaluated there. The systemd layer is
 * a stand-in (caged-launch.ts).
 */

const skip =
	liveGate("dev-env-apply-live", bwrapSkipReason()) ??
	liveGate("dev-env-apply-live", nixSkipReason(), "nix");

const dod = (run: string) =>
	({ verifier: "deterministic", checks: [{ run }] }) as never;

describe.skipIf(skip !== null)("a check with the approved environment", () => {
	let lab: EnvLab;
	let handle: ProjectDbHandle;
	let root: string;
	let commit: string;
	let builds = 0;
	const steps = () =>
		cagedSteps({
			home: lab.home,
			path: process.env.PATH ?? "",
			shim: lab.shim,
		});

	const resolveFor = (
		r: string,
		build: boolean,
	): Promise<
		import("../src/containment/dev-env-resolve.ts").DevEnvResolution
	> =>
		resolveDevEnv({
			mfwHome: lab.mfwHome,
			project: "fixture",
			root: r,
			config: undefined,
			rev: "main",
			build,
			seams: {
				steps: steps(),
				run: (req: EnvRunRequest) => {
					builds++;
					return runEnvStep(req);
				},
			} as ResolveDevEnvInput["seams"],
		});

	const checker = (r: string, devEnv: boolean) => {
		const runner = createCheckSandbox({
			db: handle.db,
			mfwHome: lab.mfwHome,
			projectRoot: r,
			stateDir: join(r, ".mfw"),
			steps: steps(),
			...(devEnv ? { devEnv: () => resolveFor(r, false) } : {}),
		});
		return new VerifierClones({
			workspaceRoot: join(lab.mfwHome, "workspaces"),
			primaryRoot: r,
			checkRunner: runner,
		});
	};

	beforeAll(async () => {
		lab = createEnvLab("env-apply");
		({ root, commit } = await lab.repo("direnv", {
			"flake.nix": tinyFlake(),
			"flake.lock": flakeLockText(),
			".envrc":
				"use flake\nexport FIXTURE_DIRENV=yes\nexport LD_PRELOAD=/work/evil.so\n",
		}));
		handle = await openProjectDb(join(root, ".mfw"));
		await allowEnv(new EnvTrustStore(lab.mfwHome), {
			project: "fixture",
			root,
			commit,
			setting: "auto",
			config: undefined,
			via: "cli",
		});
		const built = await resolveFor(root, true);
		if (built.kind !== "ready") throw new Error(JSON.stringify(built));
	}, 300_000);
	afterAll(() => {
		handle.close();
		lab.dispose();
	});

	test("positive control: without the environment the dev shell's tool is absent", async () => {
		const r = await verifyInClone(
			checker(root, false),
			commit,
			"live",
			dod("command -v hello"),
			commit,
		);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.exitCode).not.toBe(0);
	}, 120_000);

	test("with it: the dev shell's tool and variables, and the hostile LD_PRELOAD dropped", async () => {
		const r = await verifyInClone(
			checker(root, true),
			commit,
			"live",
			dod(
				'hello | grep -q "Hello, world" && test "$FIXTURE_DIRENV" = yes && test "$FIXTURE_FLAKE" = yes && test -z "$LD_PRELOAD"',
			),
			commit,
		);
		expect(r.checks[0]?.detail).toBeUndefined();
		expect(r.passed).toBe(true);
	}, 120_000);

	test("nix develop -c as checkPrefix works through the applied environment", async () => {
		const r = await verifyInClone(
			checker(root, true),
			commit,
			"live",
			dod("hello >/dev/null"),
			commit,
			{ checkPrefix: "nix develop -c" },
		);
		expect(r.passed).toBe(true);
		// Without an environment to apply, the loader prefix is refused, never a pass.
		const without = await verifyInClone(
			checker(root, false),
			commit,
			"live",
			dod("true"),
			commit,
			{ checkPrefix: "nix develop -c" },
		);
		expect(without.passed).toBe(false);
	}, 120_000);

	test("the closure is read-only and the rest of the store stays hidden", async () => {
		const mise = (process.env.PATH ?? "")
			.split(":")
			.find((p) => /-mise-[^/]*\/bin$/.test(p));
		const r = await verifyInClone(
			checker(root, true),
			commit,
			"live",
			dod(
				`hello_bin=$(command -v hello) && ! touch "$hello_bin" 2>/dev/null && ! touch "\${hello_bin%/bin/hello}/x" 2>/dev/null${mise ? ` && test ! -e "${mise}/mise"` : ""}`,
			),
			commit,
		);
		expect(r.checks[0]?.detail).toBeUndefined();
		expect(r.passed).toBe(true);
	}, 120_000);

	test("the cached environment is reused: no second evaluation", async () => {
		const before = builds;
		const again = await resolveFor(root, true);
		expect(again.kind).toBe("ready");
		expect(builds).toBe(before);
	}, 60_000);

	test("mise: the installed tool runs from the read-only data directory", async () => {
		const m = await lab.repo("mise", {
			"mise.toml": '[tools]\njq = "1.7.1"\n',
		});
		await allowEnv(new EnvTrustStore(lab.mfwHome), {
			project: "fixture",
			root: m.root,
			commit: m.commit,
			setting: "auto",
			config: undefined,
			via: "cli",
		});
		expect((await resolveFor(m.root, true)).kind).toBe("ready");
		const mh = await openProjectDb(join(m.root, ".mfw"));
		try {
			const runner = createCheckSandbox({
				db: mh.db,
				mfwHome: lab.mfwHome,
				projectRoot: m.root,
				stateDir: join(m.root, ".mfw"),
				steps: steps(),
				devEnv: () => resolveFor(m.root, false),
			});
			const clones = new VerifierClones({
				workspaceRoot: join(lab.mfwHome, "workspaces"),
				primaryRoot: m.root,
				checkRunner: runner,
			});
			const r = await verifyInClone(
				clones,
				m.commit,
				"live",
				dod(
					'test "$(jq --version)" = jq-1.7.1 && ! touch /cache/env-data/x 2>/dev/null',
				),
				m.commit,
			);
			expect(r.checks[0]?.detail).toBeUndefined();
			expect(r.passed).toBe(true);
		} finally {
			mh.close();
		}
	}, 300_000);
});
