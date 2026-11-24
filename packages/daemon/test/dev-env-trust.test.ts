import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifySource,
	detectEnvSource,
	hashCommitFiles,
	resolveCommit,
} from "../src/containment/dev-env-sources.ts";
import {
	allowEnv,
	denyEnv,
	EnvTrustStore,
	envConfigHash,
	envFingerprint,
	envStatusAt,
	lockfileKey,
	protectedEnvPaths,
} from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";

let base: string;
let repo: string;
let home: string;

async function commitAll(msg: string): Promise<string> {
	await git(["add", "-A"], repo);
	await git(["commit", "-q", "--allow-empty", "-m", msg], repo);
	return (await git(["rev-parse", "HEAD"], repo)).stdout;
}

beforeAll(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-trust-")));
	repo = join(base, "repo");
	home = join(base, "mfw");
	mkdirSync(repo);
	mkdirSync(home);
	await git(["init", "-q", "-b", "main", "."], repo);
	await git(["config", "user.email", "t@t"], repo);
	await git(["config", "user.name", "t"], repo);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("classifySource", () => {
	test("direnv wins over mise, flake and devenv", () => {
		expect(
			classifySource([".envrc", "mise.toml", "flake.nix", "devenv.nix"]),
		).toEqual({ kind: "direnv", ignored: ["mise", "flake", "devenv"] });
	});
	test("then mise, then flake, then devenv", () => {
		expect(classifySource([".tool-versions", "flake.nix"]).kind).toBe("mise");
		expect(classifySource(["flake.nix", "flake.lock"]).kind).toBe("flake");
		expect(classifySource(["devenv.yaml"]).kind).toBe("devenv");
	});
	test("a lock alone selects nothing", () => {
		expect(classifySource(["flake.lock", "devenv.lock"]).kind).toBe("none");
	});
	test("an evaluator-less setup is refused with a fix", () => {
		const r = classifySource(["shell.nix"]);
		expect(r.kind).toBe("unsupported");
		expect((r as { fix: string }).fix).toContain("use nix");
		expect(classifySource([".nvmrc"]).kind).toBe("unsupported");
	});
	test("env.source none runs on the host toolchain; an explicit source must exist", () => {
		expect(classifySource([".envrc"], "none").kind).toBe("none");
		expect(classifySource([".envrc", "mise.toml"], "mise")).toEqual({
			kind: "mise",
			ignored: ["direnv"],
		});
		expect(classifySource(["mise.toml"], "flake").kind).toBe("unsupported");
	});
});

describe("environment files at a commit", () => {
	let c1: string;
	test("hashes each file's exact bytes, nested mise configs included", async () => {
		writeFileSync(join(repo, ".envrc"), "use flake\n");
		mkdirSync(join(repo, ".config"));
		writeFileSync(join(repo, ".config/mise.toml"), '[tools]\njq = "1.7.1"\n');
		writeFileSync(join(repo, "flake.nix"), "{ outputs = _: {}; }\n");
		writeFileSync(join(repo, "README"), "hi\n");
		c1 = await commitAll("one");
		const d = await detectEnvSource(repo, c1);
		expect(d.kind).toBe("direnv");
		expect(d.files.map((f) => f.path)).toEqual([
			".config/mise.toml",
			".envrc",
			"flake.nix",
		]);
		const envrc = d.files.find((f) => f.path === ".envrc");
		expect(envrc?.sha256).toBe(
			createHash("sha256").update("use flake\n").digest("hex"),
		);
	});

	test("resolves a branch name to the full commit and rejects option-like revs", async () => {
		expect(await resolveCommit(repo, "main")).toBe(c1);
		await expect(resolveCommit(repo, "--all")).rejects.toThrow("invalid");
		await expect(resolveCommit(repo, "no-such-branch")).rejects.toThrow();
	});

	test("a symlinked environment file is refused, not followed", async () => {
		const side = join(base, "side");
		mkdirSync(side);
		await git(["init", "-q", "-b", "main", "."], side);
		await git(["config", "user.email", "t@t"], side);
		await git(["config", "user.name", "t"], side);
		writeFileSync(join(side, "real"), "use flake\n");
		symlinkSync("real", join(side, ".envrc"));
		await git(["add", "-A"], side);
		await git(["commit", "-q", "-m", "link"], side);
		const sha = (await git(["rev-parse", "HEAD"], side)).stdout;
		await expect(hashCommitFiles(side, sha, [".envrc"])).rejects.toThrow(
			"symlink",
		);
	});

	test("path traversal in a requested name is refused", async () => {
		await expect(hashCommitFiles(repo, c1, ["../x"])).rejects.toThrow(
			"not a repository path",
		);
	});
});

describe("the trust store and drift", () => {
	let approved: string;
	let store: EnvTrustStore;
	const config = { setup: ["bun install --frozen-lockfile"] };
	const status = (commit: string, cfg: unknown = config) =>
		envStatusAt({ store, root: repo, commit, setting: "auto", config: cfg });

	beforeAll(async () => {
		store = new EnvTrustStore(home);
		approved = await resolveCommit(repo, "HEAD");
	});

	test("no record means not approved", async () => {
		expect((await status(approved)).state).toBe("not_approved");
	});

	test("allow records the commit and every file, and covers that commit", async () => {
		const rec = await allowEnv(store, {
			project: "p",
			root: repo,
			commit: approved,
			setting: "auto",
			config,
			via: "cli",
		});
		expect(rec.files.map((f) => f.path)).toContain(".envrc");
		expect(rec.configHash).toBe(envConfigHash(config));
		const s = await status(approved);
		expect(s.state).toBe("approved");
		expect(s.state === "approved" && s.fingerprint).toBe(envFingerprint(rec));
		expect(protectedEnvPaths(rec)).toEqual([
			".config/mise.toml",
			".envrc",
			"flake.nix",
		]);
		// Nothing of direnv's or mise's own state is involved.
		expect(readdirSync(join(home, "env")).sort()).toEqual([
			"approvals",
			"locks",
		]);
	});

	test("a later commit that leaves the env files alone is covered", async () => {
		writeFileSync(join(repo, "README"), "changed\n");
		const later = await commitAll("readme");
		expect((await status(later)).state).toBe("approved");
	});

	test("a changed .envrc drifts, naming the file", async () => {
		writeFileSync(join(repo, ".envrc"), "use flake\ndotenv\n");
		const drift = await commitAll("envrc");
		const s = await status(drift);
		expect(s.state).toBe("drifted");
		expect(s.state === "drifted" && s.changed).toEqual([".envrc"]);
		writeFileSync(join(repo, ".envrc"), "use flake\n");
		await commitAll("revert");
	});

	test("a new environment file drifts too", async () => {
		writeFileSync(join(repo, ".tool-versions"), "jq 1.7.1\n");
		const added = await commitAll("tool-versions");
		const s = await status(added);
		expect(s.state === "drifted" && s.changed).toEqual([".tool-versions"]);
		rmSync(join(repo, ".tool-versions"));
		await commitAll("drop");
	});

	test("a changed config drifts", async () => {
		const s = await status(approved, { setup: ["npm ci"] });
		expect(s.state === "drifted" && s.configChanged).toBe(true);
	});

	test("a discovered (sourced) file is part of the approval", async () => {
		writeFileSync(join(repo, "env.sh"), "export A=1\n");
		const withSourced = await commitAll("sourced");
		await allowEnv(store, {
			project: "p",
			root: repo,
			commit: withSourced,
			setting: "auto",
			config,
			via: "cli",
		});
		const rec = store.read(repo);
		if (!rec) throw new Error("no record");
		const [sourced] = await hashCommitFiles(repo, withSourced, ["env.sh"]);
		await store.addDiscovered(repo, envFingerprint(rec), [sourced as never]);
		expect(protectedEnvPaths(store.read(repo))).toContain("env.sh");
		expect((await status(withSourced)).state).toBe("approved");
		writeFileSync(join(repo, "env.sh"), "export LD_PRELOAD=/x\n");
		const changed = await commitAll("sourced changed");
		const s = await status(changed);
		expect(s.state === "drifted" && s.changed).toEqual(["env.sh"]);
	});

	test("addDiscovered never revives a record that changed meanwhile", async () => {
		const rec = store.read(repo);
		if (!rec) throw new Error("no record");
		const stale = envFingerprint({ ...rec, commit: approved });
		expect(await store.addDiscovered(repo, stale, [])).toBeNull();
	});

	test("deny refuses until allowed again", async () => {
		await denyEnv(store, {
			project: "p",
			root: repo,
			commit: approved,
			config,
			via: "cli",
		});
		expect((await status(approved)).state).toBe("denied");
		expect(protectedEnvPaths(store.read(repo))).toEqual([]);
	});

	test("an unsupported setup cannot be approved", async () => {
		const other = join(base, "nix-only");
		mkdirSync(other);
		await git(["init", "-q", "-b", "main", "."], other);
		await git(["config", "user.email", "t@t"], other);
		await git(["config", "user.name", "t"], other);
		writeFileSync(join(other, "shell.nix"), "{}\n");
		await git(["add", "-A"], other);
		await git(["commit", "-q", "-m", "s"], other);
		const sha = (await git(["rev-parse", "HEAD"], other)).stdout;
		await expect(
			allowEnv(store, {
				project: "q",
				root: other,
				commit: sha,
				setting: "auto",
				config: {},
				via: "cli",
			}),
		).rejects.toThrow("use nix");
		expect(
			(
				await envStatusAt({
					store,
					root: other,
					commit: sha,
					setting: "auto",
					config: {},
				})
			).state,
		).toBe("unsupported");
	});

	test("a malformed or foreign record reads as no approval", () => {
		const dir = join(home, "env/approvals");
		for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "{nope");
		expect(store.read(repo)).toBeNull();
	});

	test("concurrent decisions serialize: the file is always one whole record", async () => {
		const input = {
			project: "p",
			root: repo,
			commit: approved,
			setting: "auto" as const,
			config,
			via: "cli" as const,
		};
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				i % 2 ? allowEnv(store, input) : denyEnv(store, input),
			),
		);
		const rec = store.read(repo);
		expect(rec?.state === "allowed" || rec?.state === "denied").toBe(true);
	});
});

describe("package lockfiles are not the environment's definition", () => {
	let r: string;
	let store: EnvTrustStore;
	const config = { setup: ["bun install --frozen-lockfile"] };
	const commitIn = async (files: Record<string, string>, msg: string) => {
		for (const [p, t] of Object.entries(files)) writeFileSync(join(r, p), t);
		await git(["add", "-A"], r);
		await git(["commit", "-q", "-m", msg], r);
		return (await git(["rev-parse", "HEAD"], r)).stdout;
	};
	const status = (commit: string) =>
		envStatusAt({ store, root: r, commit, setting: "auto", config });
	const pkg = (
		deps: Record<string, string>,
		scripts: Record<string, string> = {},
	) => `${JSON.stringify({ name: "x", dependencies: deps, scripts })}\n`;
	let approved: string;

	beforeAll(async () => {
		r = join(base, "locks");
		mkdirSync(r);
		await git(["init", "-q", "-b", "main", "."], r);
		await git(["config", "user.email", "t@t"], r);
		await git(["config", "user.name", "t"], r);
		approved = await commitIn(
			{
				".envrc": "use flake\n",
				"flake.nix": "{ outputs = _: {}; }\n",
				"flake.lock": "{}\n",
				"bun.lock": "v1\n",
				"package.json": pkg({ a: "1" }),
			},
			"base",
		);
		store = new EnvTrustStore(join(base, "mfw-locks"));
		await allowEnv(store, {
			project: "l",
			root: r,
			commit: approved,
			setting: "auto",
			config,
			via: "cli",
		});
	});

	test("the approval still records the lockfiles' bytes", () => {
		expect(store.read(r)?.files.map((f) => f.path)).toEqual([
			".envrc",
			"bun.lock",
			"flake.lock",
			"flake.nix",
			"package.json",
		]);
	});

	test("a lockfile-only change stays approved, under the same environment fingerprint", async () => {
		const before = await status(approved);
		const c = await commitIn({ "bun.lock": "v2\n" }, "lock");
		const s = await status(c);
		expect(s.state).toBe("approved");
		if (s.state !== "approved" || before.state !== "approved") return;
		expect(s.fingerprint).toBe(before.fingerprint);
		expect(s.lockfilesChanged).toEqual(["bun.lock"]);
		expect(s.commit).toBe(c);
		expect(lockfileKey(s.lockfiles)).not.toBe(lockfileKey(before.lockfiles));
	});

	test("a dependency bump in package.json is part of the lockfile class", async () => {
		const c = await commitIn(
			{ "package.json": pkg({ a: "2", b: "1" }), "bun.lock": "v3\n" },
			"bump",
		);
		const s = await status(c);
		expect(s.state).toBe("approved");
		expect(s.state === "approved" && s.lockfilesChanged).toEqual([
			"bun.lock",
			"package.json",
		]);
	});

	test("a changed install script in package.json asks again", async () => {
		const c = await commitIn(
			{
				"package.json": pkg({ a: "2", b: "1" }, { postinstall: "curl x | sh" }),
			},
			"script",
		);
		const s = await status(c);
		expect(s.state === "drifted" && s.changed).toEqual(["package.json"]);
		await commitIn({ "package.json": pkg({ a: "2", b: "1" }) }, "unscript");
	});

	test("a nix lockfile change asks again", async () => {
		const c = await commitIn({ "flake.lock": '{"v":2}\n' }, "nix lock");
		const s = await status(c);
		expect(s.state === "drifted" && s.changed).toEqual(["flake.lock"]);
		await commitIn({ "flake.lock": "{}\n" }, "nix lock back");
	});

	test("a lockfile together with an .envrc change asks again", async () => {
		const c = await commitIn(
			{ "bun.lock": "v4\n", ".envrc": "use flake\ndotenv\n" },
			"mixed",
		);
		const s = await status(c);
		expect(s.state).toBe("drifted");
		expect(s.state === "drifted" && s.changed).toEqual([".envrc"]);
	});

	test("a changed setup command asks again", async () => {
		const s = await envStatusAt({
			store,
			root: r,
			commit: approved,
			setting: "auto",
			config: { setup: ["npm ci"] },
		});
		expect(s.state === "drifted" && s.configChanged).toBe(true);
	});

	test("the merge gate protects the definition, not the package lockfiles", () => {
		expect(protectedEnvPaths(store.read(r))).toEqual([
			".envrc",
			"flake.lock",
			"flake.nix",
		]);
	});
});
