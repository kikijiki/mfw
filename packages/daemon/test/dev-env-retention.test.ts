import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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

/** F5 of the P8 review: captures and their GC roots do not pile up forever. */

let base: string;
let root: string;
let mfwHome: string;
const fakeRun = async (_req: EnvRunRequest): Promise<EnvRunResult> => ({
	ok: true,
	output: Buffer.from('{"A":"1"}'),
	log: "",
	egress: null,
	sandboxPath: [],
	sandboxEnv: {},
});
const gcRoots = async (dir: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "r"), "root\n");
	return true;
};

beforeAll(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-keep-")));
	root = join(base, "p");
	mfwHome = join(base, "mfw");
	mkdirSync(root);
	mkdirSync(mfwHome);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("only the 3 newest captures of a project are kept, with their GC roots", async () => {
	const fingerprints: string[] = [];
	for (let i = 0; i < 5; i++) {
		writeFileSync(join(root, ".envrc"), `export N=${i}\n`);
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", `c${i}`], root);
		const commit = (await git(["rev-parse", "HEAD"], root)).stdout;
		await allowEnv(new EnvTrustStore(mfwHome), {
			project: "p",
			root,
			commit,
			setting: "auto",
			config: {},
			via: "cli",
		});
		const r = await resolveDevEnv({
			mfwHome,
			project: "p",
			root,
			config: {},
			rev: "main",
			build: true,
			seams: {
				run: fakeRun,
				closure: () => ({ method: "nix-store", paths: [] }),
				gcRoots,
			},
		});
		if (r.kind !== "ready") throw new Error(JSON.stringify(r));
		fingerprints.push(r.fingerprint);
		await Bun.sleep(5);
	}
	const cacheRoot = join(mfwHome, "env/cache");
	const [projectDir] = readdirSync(cacheRoot);
	const kept = readdirSync(join(cacheRoot, projectDir as string)).sort();
	expect(kept).toEqual(fingerprints.slice(-3).sort());
	for (const fp of fingerprints.slice(0, 2)) {
		expect(
			existsSync(join(cacheRoot, projectDir as string, fp, "gcroots")),
		).toBe(false);
	}
	for (const fp of fingerprints.slice(-3)) {
		expect(
			existsSync(join(cacheRoot, projectDir as string, fp, "gcroots/r")),
		).toBe(true);
	}
});
