import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { createCheckSandbox } from "../src/containment/check-sandbox.ts";
import {
	type EnvRunRequest,
	runEnvStep,
} from "../src/containment/dev-env-build.ts";
import type { EnvConfig } from "../src/containment/dev-env-config.ts";
import { seedDeps } from "../src/containment/dev-env-deps.ts";
import {
	type DevEnvResolution,
	type ResolveDevEnvInput,
	resolveDevEnv,
} from "../src/containment/dev-env-resolve.ts";
import { allowEnv, EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";
import { verifyInClone } from "../src/verifier.ts";
import { cagedSteps } from "./support/caged-launch.ts";
import {
	bwrapSkipReason,
	createEnvLab,
	type EnvLab,
} from "./support/dev-env-fixture.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * The deps layer under real bwrap: `env.setup` in the env-install sandbox with
 * registry egress only, its output cached and copied into a verifier clone,
 * which has no network. Needs the npm registry; the systemd layer is a
 * stand-in (caged-launch.ts).
 */

const skip = liveGate("dev-env-deps-live", bwrapSkipReason());

describe.skipIf(skip !== null)(
	"installing dependencies for an approved environment",
	() => {
		let lab: EnvLab;
		let handle: ProjectDbHandle;
		let root: string;
		let commit: string;
		let installs = 0;
		const config: EnvConfig = {
			setup: ["bun install --no-save"],
		};
		const steps = () =>
			cagedSteps({
				home: lab.home,
				path: process.env.PATH ?? "",
				shim: lab.shim,
			});
		const resolve = (build: boolean): Promise<DevEnvResolution> =>
			resolveDevEnv({
				mfwHome: lab.mfwHome,
				project: "deps",
				root,
				config,
				rev: "main",
				build,
				seams: {
					steps: steps(),
					run: (req: EnvRunRequest) => {
						if (req.step === "setup") installs++;
						return runEnvStep(req);
					},
				} as ResolveDevEnvInput["seams"],
			});

		beforeAll(async () => {
			lab = createEnvLab("env-deps");
			({ root, commit } = await lab.repo("deps", {
				"package.json": `${JSON.stringify(
					{
						name: "fixture",
						private: true,
						dependencies: { "is-number": "7.0.0" },
						scripts: {
							postinstall:
								'echo ran > node_modules/.postinstall-ran; bun -e \'try { const r = await fetch("https://example.com/"); await Bun.write("node_modules/.net", String(r.status)) } catch { await Bun.write("node_modules/.net", "blocked") }\'',
						},
					},
					null,
					2,
				)}\n`,
				".gitignore": ".mfw/\nnode_modules/\n",
			}));
			handle = await openProjectDb(join(root, ".mfw"));
		}, 60_000);
		afterAll(() => {
			handle.close();
			lab.dispose();
		});

		test("a setup-only project still needs the owner's approval", async () => {
			const r = await resolve(true);
			expect(r.kind === "refused" && r.code).toBe("env_not_approved");
			expect(installs).toBe(0);
		});

		test("setup runs in its sandbox, lifecycle scripts included, with registry egress only", async () => {
			await allowEnv(new EnvTrustStore(lab.mfwHome), {
				project: "deps",
				root,
				commit,
				setting: "auto",
				config,
				via: "cli",
			});
			const rec = new EnvTrustStore(lab.mfwHome).read(root);
			expect(rec?.files.map((f) => f.path)).toEqual(["package.json"]);
			const r = await resolve(true);
			if (r.kind === "refused") console.log(r.reason, r.log);
			expect(r.kind).toBe("ready");
			if (r.kind !== "ready" || !r.deps) throw new Error("no deps");
			expect(r.deps.outputs).toEqual(["node_modules"]);
			expect(r.deps.egress.allowed).toEqual(["registry.npmjs.org:443"]);
			expect(r.deps.egress.denied).toContain("example.com:443");
			const nm = join(r.deps.dir, "node_modules");
			expect(readFileSync(join(nm, ".postinstall-ran"), "utf8").trim()).toBe(
				"ran",
			);
			expect(readFileSync(join(nm, ".net"), "utf8")).not.toMatch(/^[23]\d\d$/);
			expect(existsSync(join(nm, "is-number/package.json"))).toBe(true);
			// The primary never got them: lifecycle scripts ran only in the clone.
			expect(existsSync(join(root, "node_modules"))).toBe(false);
			lab.assertCanaries();
		}, 300_000);

		test("a verifier clone gets the cached deps and needs no network", async () => {
			const runner = createCheckSandbox({
				db: handle.db,
				mfwHome: lab.mfwHome,
				projectRoot: root,
				stateDir: join(root, ".mfw"),
				steps: steps(),
				devEnv: () => resolve(false),
			});
			const clones = new VerifierClones({
				workspaceRoot: join(lab.mfwHome, "workspaces"),
				primaryRoot: root,
				checkRunner: runner,
				prepareTree: async (tree) => {
					const r = await resolve(false);
					if (r.kind === "ready" && r.deps) await seedDeps(tree, r.deps);
				},
			});
			const before = installs;
			const v = await verifyInClone(
				clones,
				commit,
				"live",
				{
					verifier: "deterministic",
					checks: [
						{ run: "bun -e 'if (!require(\"is-number\")(7)) process.exit(3)'" },
					],
				} as never,
				commit,
			);
			expect(v.checks[0]?.detail).toBeUndefined();
			expect(v.passed).toBe(true);
			expect(installs).toBe(before);
		}, 120_000);

		test("seeding leaves tracked content alone", async () => {
			const r = await resolve(false);
			if (r.kind !== "ready" || !r.deps) throw new Error("no deps");
			const m = await lab.repo("tracked", {
				"node_modules/keep.txt": "mine\n",
			});
			const tree = join(lab.base, "seed-tree");
			Bun.spawnSync(["cp", "-a", m.root, tree]);
			expect(await seedDeps(tree, r.deps)).toEqual([]);
			expect(readFileSync(join(tree, "node_modules/keep.txt"), "utf8")).toBe(
				"mine\n",
			);
		});

		test("a dependency bump alone reinstalls in its sandbox, with no approval", async () => {
			const before = installs;
			const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
			pkg.dependencies["is-number"] = "6.0.0";
			await Bun.write(
				join(root, "package.json"),
				`${JSON.stringify(pkg, null, 2)}\n`,
			);
			await git(["commit", "-q", "-am", "bump"], root);
			const r = await resolve(true);
			if (r.kind === "refused") console.log(r.reason, r.log);
			expect(r.kind).toBe("ready");
			if (r.kind !== "ready" || !r.deps) throw new Error("no deps");
			expect(installs).toBe(before + 1);
			const v = JSON.parse(
				readFileSync(
					join(r.deps.dir, "node_modules/is-number/package.json"),
					"utf8",
				),
			).version;
			expect(v).toBe("6.0.0");
			// The approval itself did not move.
			expect(new EnvTrustStore(lab.mfwHome).read(root)?.commit).toBe(commit);
		}, 300_000);
	},
);
