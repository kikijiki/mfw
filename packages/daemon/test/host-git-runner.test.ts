import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import {
	buildTamperedClone,
	plainGit,
	type TamperedClone,
} from "./fixtures/tampered-clone.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fixture(): Promise<TamperedClone> {
	const t = await buildTamperedClone();
	dirs.push(t.root);
	return t;
}

function hostFor(
	t: TamperedClone,
	extra: Partial<ConstructorParameters<typeof HostGit>[0]> = {},
) {
	return new HostGit({
		workspaceRoot: t.workspaceRoot,
		ownedRoots: [t.scratchRoot],
		...extra,
	});
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof HostGitError) return e.code;
		throw e;
	}
	return "none";
}

describe("HostGit refuses the workspace root", () => {
	test("cwd under the workspace root", async () => {
		const t = await fixture();
		expect(
			await codeOf(
				hostFor(t).run(["for-each-ref"], { cwd: t.clone, repo: t.primary }),
			),
		).toBe("path_under_workspace");
		expect(
			await codeOf(
				hostFor(t).run(["for-each-ref"], {
					cwd: join(t.clone, ".git"),
					repo: t.primary,
				}),
			),
		).toBe("path_under_workspace");
	});

	test("a repo under the workspace root", async () => {
		const t = await fixture();
		const h = hostFor(t);
		expect(
			await codeOf(h.run(["for-each-ref"], { cwd: t.primary, repo: t.clone })),
		).toBe("path_under_workspace");
		expect(
			await codeOf(
				h.run(["for-each-ref"], {
					cwd: t.primary,
					repo: join(t.clone, ".git"),
				}),
			),
		).toBe("path_under_workspace");
	});

	test("every subcommand but init needs an explicit repo", async () => {
		const t = await fixture();
		expect(
			await codeOf(hostFor(t).run(["for-each-ref"], { cwd: t.primary })),
		).toBe("bad_argument");
	});

	test("a symlink into the workspace is resolved", async () => {
		const t = await fixture();
		const link = join(t.root, "innocent");
		await symlink(t.clone, link);
		expect(
			await codeOf(hostFor(t).run(["for-each-ref"], { cwd: link, repo: link })),
		).toBe("path_under_workspace");
	});

	test("a gitfile that points into the workspace", async () => {
		const t = await fixture();
		const d = await mkdtemp(join(tmpdir(), "mfw-gitfile-"));
		dirs.push(d);
		await writeFile(join(d, ".git"), `gitdir: ${join(t.clone, ".git")}\n`);
		expect(
			await codeOf(hostFor(t).run(["for-each-ref"], { cwd: d, repo: d })),
		).toBe("path_under_workspace");
	});

	test("a host-owned cwd is allowed", async () => {
		const t = await fixture();
		const r = await hostFor(t).run(["rev-parse", "--is-bare-repository"], {
			cwd: t.primary,
			repo: t.primary,
		});
		expect(r.stdout).toBe("false");
	});
});

describe("HostGit allowlist", () => {
	const bad: string[][] = [
		["fetch", "-C", "/tmp"],
		["fetch", "-c", "core.fsmonitor=/bin/true"],
		["fetch", "--git-dir=/tmp/x"],
		["fetch", "--work-tree=/tmp/x"],
		["fetch", "--upload-pack=touch /tmp/pwn"],
		// git expands abbreviated long options; the denylist missed these.
		["fetch", "--upload-pac=touch /tmp/pwn"],
		["fetch", "--upload-p=touch /tmp/pwn"],
		["fetch", "--recurse-submodules"],
		["fetch", "--exec=x"],
		["fetch", "-ccore.pager=x"],
		["fetch", "--config-env=a=b"],
		["for-each-ref", "--shell", "--format=x"],
		["cat-file", "--filters"],
		["diff-tree", "--ext-diff"],
		["diff-tree", "--textconv"],
		// global options and non-allowlisted subcommands
		["-c", "core.fsmonitor=x", "status"],
		["--exec-path=/tmp/x", "fetch"],
		["-C", "/tmp", "fetch"],
		["ls-remote", "--upload-p=touch /tmp/pwn"],
		["grep", "-Otouch /tmp/pwn", "x"],
		["status"],
		["checkout", "main"],
		["clone", "--", "x"],
		["config", "--get", "x"],
		[],
	];
	for (const args of bad) {
		test(JSON.stringify(args), async () => {
			const t = await fixture();
			const code = await codeOf(hostFor(t).run(args, { cwd: t.primary }));
			expect(["option_injection", "bad_argument"]).toContain(code);
		});
	}

	test("fetch and init need a -- before their operands", async () => {
		const t = await fixture();
		expect(
			await codeOf(hostFor(t).run(["fetch", "/x", "ref"], { cwd: t.primary })),
		).toBe("bad_argument");
	});

	test("options after -- are data, allowlisted ones before it pass", async () => {
		const t = await fixture();
		const h = hostFor(t);
		expect(() =>
			h.check(["fetch", "--no-tags", "--", "--upload-pack=x", "r"], {
				cwd: t.primary,
				repo: t.primary,
			}),
		).not.toThrow();
		expect(() =>
			h.check(["for-each-ref", "--format=%(refname)", "refs/"], {
				cwd: t.primary,
				repo: t.primary,
			}),
		).not.toThrow();
	});
});

describe("HostGit environment and config", () => {
	test("the child env is scrubbed and the config prelude is fixed", async () => {
		const t = await fixture();
		const fake = join(t.root, "fake-git");
		await writeFile(fake, '#!/bin/sh\nenv\necho "ARGS: $*"\n');
		await chmod(fake, 0o755);
		const h = hostFor(t, {
			gitBin: fake,
			baseEnv: {
				PATH: "/usr/bin",
				GIT_DIR: "/tmp/evil",
				GIT_WORK_TREE: "/tmp/evil",
				GIT_OBJECT_DIRECTORY: "/tmp/evil",
				GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil",
				GIT_EXEC_PATH: "/tmp/evil",
				GIT_PROXY_COMMAND: "/tmp/evil",
				GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/tmp/evil'",
				HOME: "/users/someone",
				SSH_AUTH_SOCK: "/tmp/agent",
			},
		});
		const r = await h.run(["for-each-ref"], {
			cwd: t.primary,
			repo: t.primary,
		});
		const out = r.stdout;
		expect(out).toContain("GIT_CONFIG_GLOBAL=/dev/null");
		expect(out).toContain("GIT_CONFIG_SYSTEM=/dev/null");
		expect(out).toContain("GIT_CONFIG_NOSYSTEM=1");
		expect(out).toContain("GIT_SSH_COMMAND=false");
		expect(out).toContain("PATH=/usr/bin");
		for (const leaked of [
			"GIT_DIR=",
			"GIT_WORK_TREE=",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE",
			"GIT_EXEC_PATH",
			"GIT_PROXY_COMMAND",
			"GIT_CONFIG_PARAMETERS",
			"/users/someone",
			"SSH_AUTH_SOCK",
		]) {
			expect(out).not.toContain(leaked);
		}
		const args = out.split("ARGS: ")[1] as string;
		expect(args).toContain("protocol.allow=never");
		expect(args).toContain("transfer.fsckObjects=true");
		expect(args).toContain("fetch.fsckObjects=true");
		expect(args).toContain("core.hooksPath=/dev/null");
		expect(args).not.toContain("protocol.file.allow");
		const withFile = await h.run(["for-each-ref"], {
			cwd: t.primary,
			repo: t.primary,
			allowFile: true,
		});
		expect(withFile.stdout).toContain("protocol.file.allow=always");
	});

	test("real git sees none of the user's global config", async () => {
		const t = await fixture();
		const home = await mkdtemp(join(tmpdir(), "mfw-home-"));
		dirs.push(home);
		await writeFile(join(home, ".gitconfig"), "[user]\n\tname = LEAKED\n");
		const h = hostFor(t, { baseEnv: { PATH: process.env.PATH, HOME: home } });
		const r = await h.run(["config", "--list", "--show-origin"], {
			cwd: t.primary,
			repo: t.primary,
		});
		expect(r.stdout).not.toContain("LEAKED");
		expect(r.stdout.toLowerCase()).toContain("core.hookspath=/dev/null");
		await mkdir(join(home, "x"));
	});
});

describe("HostGit repo resolution (security review H3)", () => {
	test("a symlinked .git is refused, and the alias canary does not run", async () => {
		const t = await fixture();
		const d = await mkdtemp(join(tmpdir(), "mfw-linkgit-"));
		dirs.push(d);
		await symlink(join(t.clone, ".git"), join(d, ".git"));
		await plainGit(["config", "alias.x", `!${t.canary} alias`], t.clone);
		expect(
			await codeOf(hostFor(t).run(["for-each-ref"], { cwd: d, repo: d })),
		).toBe("path_under_workspace");
		expect(await readFile(t.canaryLog, "utf8")).toBe("");
	});

	test("commondir, alternates, objects and pack symlinks into the workspace are refused", async () => {
		const t = await fixture();
		const h = hostFor(t);
		const mk = async (name: string) => {
			const repo = join(t.root, name);
			await plainGit(["init", "-q", "--bare", repo], t.root);
			return repo;
		};
		const a = await mk("host-a.git");
		await writeFile(join(a, "commondir"), `${join(t.clone, ".git")}\n`);
		const b = await mk("host-b.git");
		await writeFile(
			join(b, "objects", "info", "alternates"),
			`${join(t.clone, ".git", "objects")}\n`,
		);
		const c = await mk("host-c.git");
		await rm(join(c, "objects", "pack"), { recursive: true });
		await symlink(
			join(t.clone, ".git", "objects", "pack"),
			join(c, "objects", "pack"),
		);
		const d = await mk("host-d.git");
		await rm(join(d, "refs"), { recursive: true });
		await symlink(join(t.clone, ".git", "refs"), join(d, "refs"));
		for (const repo of [a, b, c, d]) {
			expect(await codeOf(h.run(["for-each-ref"], { cwd: t.root, repo }))).toBe(
				"path_under_workspace",
			);
		}
		// control: an untouched host bare repo is accepted
		const ok = await mk("host-ok.git");
		expect(
			(await h.run(["for-each-ref"], { cwd: t.root, repo: ok })).exitCode,
		).toBe(0);
	});

	test("a gitfile .git is refused", async () => {
		const t = await fixture();
		const d = await mkdtemp(join(tmpdir(), "mfw-gitfile-"));
		dirs.push(d);
		await writeFile(join(d, ".git"), "gitdir: /somewhere/else\n");
		expect(
			await codeOf(hostFor(t).run(["for-each-ref"], { cwd: d, repo: d })),
		).toBe("path_under_workspace");
	});

	test("git does not discover a repo above cwd", async () => {
		const t = await fixture();
		// root/.git is a symlink to the armed clone; scratch/ sits below it.
		await symlink(join(t.clone, ".git"), join(t.root, ".git"));
		const h = hostFor(t);
		const bare = join(t.scratchRoot, "x.git");
		await h.runOk(["init", "--bare", "--quiet", "--", bare], {
			cwd: t.scratchRoot,
		});
		await h.runOk(["for-each-ref"], { cwd: t.scratchRoot, repo: bare });
		expect(await readFile(t.canaryLog, "utf8")).toBe("");
		// control: plain git below the symlinked .git discovers the clone and runs its fsmonitor
		await plainGit(["status"], t.scratchRoot).catch(() => {});
		expect((await readFile(t.canaryLog, "utf8")).length).toBeGreaterThan(0);
	});
});
