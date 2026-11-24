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
import { resolveDevEnv } from "../src/containment/dev-env-resolve.ts";
import { allowEnv, EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";

/**
 * The cache keys of the two classes: the evaluated environment by its
 * definition, the installed dependencies also by the package lockfiles. A
 * lockfile-only change installs again with no approval; anything else asks.
 */

let base: string;
let root: string;
let mfwHome: string;
const config = { setup: ["bun install --frozen-lockfile"] };
const ran: { step: string; commit: string }[] = [];

const fakeRun = async (req: EnvRunRequest): Promise<EnvRunResult> => {
	ran.push({ step: req.step, commit: req.commit });
	if (req.step === "setup") {
		const tree = join(base, `tree-${ran.length}`);
		mkdirSync(join(tree, "node_modules/dep"), { recursive: true });
		writeFileSync(join(tree, "node_modules/dep/v"), `${req.commit}\n`);
		await req.collectTree?.(tree);
	}
	return {
		ok: true,
		output: Buffer.from(req.step === "setup" ? "" : '{"FROM_ENV":"1"}'),
		log: "",
		egress: null,
		sandboxPath: [],
		sandboxEnv: {},
	};
};

const resolve = () =>
	resolveDevEnv({
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

async function commitIn(files: Record<string, string>): Promise<string> {
	for (const [p, t] of Object.entries(files)) writeFileSync(join(root, p), t);
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "c"], root);
	return (await git(["rev-parse", "HEAD"], root)).stdout;
}

beforeAll(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-locks-")));
	root = join(base, "p");
	mfwHome = join(base, "mfw");
	mkdirSync(root);
	mkdirSync(mfwHome);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	const c = await commitIn({
		".envrc": "use flake\n",
		"bun.lock": "v1\n",
		"package.json": '{"dependencies":{"dep":"1"}}\n',
	});
	await allowEnv(new EnvTrustStore(mfwHome), {
		project: "p",
		root,
		commit: c,
		setting: "auto",
		config,
		via: "cli",
	});
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("cache keys of the environment and its dependencies", () => {
	test("the first resolve evaluates once and installs once", async () => {
		const r = await resolve();
		expect(r.kind).toBe("ready");
		expect(ran.map((x) => x.step)).toEqual(["direnv", "setup"]);
	});

	test("a lockfile-only change reinstalls at its commit, and reuses the evaluation", async () => {
		const c = await commitIn({
			"bun.lock": "v2\n",
			"package.json": '{"dependencies":{"dep":"2"}}\n',
		});
		const before = ran.length;
		const r = await resolve();
		expect(r.kind).toBe("ready");
		expect(ran.slice(before)).toEqual([{ step: "setup", commit: c }]);
		if (r.kind !== "ready" || !r.deps) throw new Error("no deps");
		expect(r.deps.outputs).toEqual(["node_modules"]);
		// Each lockfile content has its own entry; the next resolve reuses it.
		const again = ran.length;
		expect((await resolve()).kind).toBe("ready");
		expect(ran.length).toBe(again);
	});

	test("lockfile and .envrc together ask again, and nothing runs", async () => {
		await commitIn({ "bun.lock": "v3\n", ".envrc": "use flake\ndotenv\n" });
		const before = ran.length;
		const r = await resolve();
		expect(r.kind === "refused" && r.code).toBe("env_drifted");
		expect(ran.length).toBe(before);
	});
});
