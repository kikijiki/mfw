import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostGit, HostGitError } from "../src/host-git/runner.ts";
import {
	buildTamperedClone,
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
		expect(await codeOf(hostFor(t).run(["status"], { cwd: t.clone }))).toBe(
			"path_under_workspace",
		);
		expect(
			await codeOf(hostFor(t).run(["status"], { cwd: join(t.clone, ".git") })),
		).toBe("path_under_workspace");
	});

	test("gitdir and work tree under the workspace root", async () => {
		const t = await fixture();
		const h = hostFor(t);
		expect(
			await codeOf(
				h.run(["status"], { cwd: t.primary, gitDir: join(t.clone, ".git") }),
			),
		).toBe("path_under_workspace");
		expect(
			await codeOf(h.run(["status"], { cwd: t.primary, workTree: t.clone })),
		).toBe("path_under_workspace");
	});

	test("a symlink into the workspace is resolved", async () => {
		const t = await fixture();
		const link = join(t.root, "innocent");
		await symlink(t.clone, link);
		expect(await codeOf(hostFor(t).run(["status"], { cwd: link }))).toBe(
			"path_under_workspace",
		);
	});

	test("a gitfile that points into the workspace", async () => {
		const t = await fixture();
		const d = await mkdtemp(join(tmpdir(), "mfw-gitfile-"));
		dirs.push(d);
		await writeFile(join(d, ".git"), `gitdir: ${join(t.clone, ".git")}\n`);
		expect(await codeOf(hostFor(t).run(["status"], { cwd: d }))).toBe(
			"path_under_workspace",
		);
	});

	test("a host-owned cwd is allowed", async () => {
		const t = await fixture();
		const r = await hostFor(t).run(["rev-parse", "--is-inside-work-tree"], {
			cwd: t.primary,
		});
		expect(r.stdout).toBe("true");
	});
});

describe("HostGit refuses option injection", () => {
	const bad = [
		["-C", "/tmp"],
		["-c", "core.fsmonitor=/bin/true"],
		["--git-dir=/tmp/x"],
		["--work-tree=/tmp/x"],
		["--upload-pack=touch /tmp/pwn"],
		["--exec-path=/tmp/x"],
		["-ccore.pager=x"],
		["--config-env=a=b"],
	];
	for (const extra of bad) {
		test(extra.join(" "), async () => {
			const t = await fixture();
			expect(
				await codeOf(hostFor(t).run(["fetch", ...extra], { cwd: t.primary })),
			).toBe("option_injection");
		});
	}

	test("options after -- are data and pass the option check", async () => {
		const t = await fixture();
		const h = hostFor(t);
		expect(() =>
			h.check(["rev-parse", "--", "--upload-pack=x"], { cwd: t.primary }),
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
		const r = await h.run(["status"], { cwd: t.primary });
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
		const withFile = await h.run(["status"], {
			cwd: t.primary,
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
		});
		expect(r.stdout).not.toContain("LEAKED");
		expect(r.stdout.toLowerCase()).toContain("core.hookspath=/dev/null");
		await mkdir(join(home, "x"));
	});
});
