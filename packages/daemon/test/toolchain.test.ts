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
import { dirname, join } from "node:path";
import {
	discoverToolchain,
	toolchainBwrapArgs,
} from "../src/containment/toolchain.ts";

/**
 * TOOL: toolchain discovery over fixture trees (NixOS, Debian, HOME-rustup).
 * Pure: the discovery runs against a temp filesystem root, no bwrap needed.
 */

const roots: string[] = [];
afterEach(async () => {
	while (roots.length)
		await rm(roots.pop() as string, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-toolchain-"));
	roots.push(root);
	return root;
}

async function exe(root: string, path: string, body = "#!/bin/sh\n") {
	const abs = join(root, path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, body);
	await chmod(abs, 0o755);
}

async function link(root: string, path: string, target: string) {
	const abs = join(root, path);
	await mkdir(dirname(abs), { recursive: true });
	await symlink(target, abs);
}

const paths = (p: { binds: { path: string }[] }) => p.binds.map((b) => b.path);

describe("toolchain discovery", () => {
	test("NixOS: store binaries bind /nix/store whole, via the profile symlink", async () => {
		const root = await fixture();
		await exe(root, "nix/store/aaa-git-2.5/bin/git");
		await link(
			root,
			"run/current-system/sw/bin/git",
			"/nix/store/aaa-git-2.5/bin/git",
		);
		await link(root, "bin/sh", "/nix/store/bbb-bash/bin/bash");
		await mkdir(join(root, "etc/static/ssl"), { recursive: true });
		await writeFile(join(root, "etc/passwd"), "");
		await writeFile(join(root, "etc/group"), "");
		await link(root, "etc/ssl", "static/ssl");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["git"],
			path: "/run/current-system/sw/bin",
			root,
		});
		expect(plan.unresolved).toEqual([]);
		expect(plan.resolved[0]?.realPath).toBe("/nix/store/aaa-git-2.5/bin/git");
		expect(paths(plan)).toContain("/nix/store");
		expect(paths(plan)).toContain("/run/current-system");
		expect(paths(plan)).toContain("/etc/passwd");
		expect(paths(plan)).toContain("/etc/static");
		expect(paths(plan)).toContain("/etc/ssl");
		expect(plan.pathDirs).toEqual(["/run/current-system/sw/bin"]);
	});

	test("Debian: system roots and the alternatives links, no nix, no HOME", async () => {
		const root = await fixture();
		await exe(root, "usr/bin/git");
		await link(root, "usr/bin/editor", "/etc/alternatives/editor");
		await mkdir(join(root, "etc/alternatives"), { recursive: true });
		await mkdir(join(root, "lib/x86_64-linux-gnu"), { recursive: true });
		await mkdir(join(root, "lib64"), { recursive: true });
		await mkdir(join(root, "etc/ssl"), { recursive: true });
		await writeFile(join(root, "etc/nsswitch.conf"), "");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["git"],
			path: "/usr/bin:/bin",
			root,
		});
		expect(plan.unresolved).toEqual([]);
		expect(paths(plan)).toEqual(
			expect.arrayContaining([
				"/usr",
				"/lib",
				"/lib64",
				"/etc/alternatives",
				"/etc/ssl",
				"/etc/nsswitch.conf",
			]),
		);
		expect(paths(plan)).not.toContain("/nix/store");
		expect(paths(plan).some((p) => p.startsWith("/home"))).toBe(false);
	});

	test("HOME-rustup: toolchain roots bind, cargo only at bin, never HOME", async () => {
		const root = await fixture();
		const home = "/users/u";
		await exe(root, `${home}/.rustup/toolchains/stable/bin/rustc`);
		await link(
			root,
			`${home}/.cargo/bin/rustc`,
			`${home}/.rustup/toolchains/stable/bin/rustc`,
		);
		await writeFile(join(root, home, ".cargo/credentials.toml"), "token");
		await exe(root, `${home}/.bun/bin/bun`);
		await exe(root, `${home}/.local/bin/claude`);
		await mkdir(join(root, home, ".ssh"), { recursive: true });
		await mkdir(join(root, home, ".aws"), { recursive: true });
		await mkdir(join(root, home, ".nvm/versions"), { recursive: true });
		const plan = discoverToolchain({
			home,
			binaries: ["rustc", "bun", "claude"],
			path: `${home}/.cargo/bin:${home}/.bun/bin:${home}/.local/bin`,
			root,
		});
		expect(plan.unresolved).toEqual([]);
		const p = paths(plan);
		expect(p).toEqual(
			expect.arrayContaining([
				`${home}/.rustup`,
				`${home}/.cargo/bin`,
				`${home}/.bun`,
				`${home}/.local/bin`,
				`${home}/.nvm/versions`,
			]),
		);
		for (const bad of [
			home,
			`${home}/.cargo`,
			`${home}/.ssh`,
			`${home}/.aws`,
		]) {
			expect(p).not.toContain(bad);
		}
	});

	test("a HOME binary outside the toolchain roots is unresolved, not bound", async () => {
		const root = await fixture();
		await exe(root, "users/u/Downloads/tool");
		await exe(root, "users/u/.ssh/evil");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["/users/u/Downloads/tool", "/users/u/.ssh/evil"],
			path: "/usr/bin",
			root,
		});
		expect(plan.resolved).toEqual([]);
		expect(plan.unresolved.map((u) => u.name)).toEqual([
			"/users/u/Downloads/tool",
			"/users/u/.ssh/evil",
		]);
		expect(paths(plan)).toEqual([]);
	});

	test("a symlink in a toolchain dir that escapes to HOME is refused, and loops are survived", async () => {
		const root = await fixture();
		await exe(root, "users/u/private/real");
		await link(root, "users/u/.local/bin/sneaky", "/users/u/private/real");
		await link(root, "users/u/.local/bin/loop", "/users/u/.local/bin/loop");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["sneaky", "loop", "missing"],
			path: "/users/u/.local/bin",
			root,
		});
		expect(plan.resolved).toEqual([]);
		expect(plan.unresolved).toHaveLength(3);
		expect(paths(plan)).not.toContain("/users/u/private");
	});

	test("X11: a toolchain root planted as a symlink into credentials is refused, not bound", async () => {
		const root = await fixture();
		const home = "/users/u";
		await writeFile(join(root, "k"), "");
		await mkdir(join(root, home, ".ssh"), { recursive: true });
		await writeFile(join(root, home, ".ssh/id_ed25519"), "KEY");
		await mkdir(join(root, home, ".claude"), { recursive: true });
		await mkdir(join(root, home, ".cargo"), { recursive: true });
		await mkdir(join(root, home, ".local"), { recursive: true });
		await link(root, `${home}/.bun`, `${home}/.ssh`);
		await link(root, `${home}/.rustup`, `${home}/.claude`);
		await link(root, `${home}/.cargo/bin`, `${home}/.cargo`);
		await link(root, `${home}/.local/bin`, `${home}`);
		await link(root, `${home}/.nvm`, "/users");
		const plan = discoverToolchain({
			home,
			binaries: ["/users/u/.bun/id_ed25519"],
			path: "/usr/bin",
			root,
		});
		const p = paths(plan);
		for (const bad of [".bun", ".rustup", ".cargo/bin", ".local/bin", ".nvm"])
			expect(p.some((x) => x.startsWith(`${home}/${bad}`))).toBe(false);
		expect(plan.resolved).toEqual([]);
		const names = plan.unresolved.map((u) => u.name);
		expect(names).toEqual(
			expect.arrayContaining(["~/.bun", "~/.rustup", "~/.cargo/bin"]),
		);
		for (const u of plan.unresolved) expect(u.reason.length).toBeGreaterThan(0);
	});

	test("X11: a link into a writable or credential dir is refused even for a named binary", async () => {
		const root = await fixture();
		const home = "/users/u";
		await exe(root, `${home}/.aws/tool`);
		await link(root, `${home}/.bun`, `${home}/.aws`);
		const plan = discoverToolchain({
			home,
			binaries: ["tool"],
			path: `${home}/.bun`,
			root,
		});
		expect(plan.resolved).toEqual([]);
		expect(plan.unresolved[0]?.name).toBe("tool");
		expect(paths(plan)).not.toContain(`${home}/.bun`);
		expect(paths(plan)).not.toContain(`${home}/.aws`);
	});

	test("X11: a root whose link points at a symlinked credential dir is refused", async () => {
		const root = await fixture();
		const home = "/users/u";
		await mkdir(join(root, "mnt/secrets"), { recursive: true });
		await link(root, `${home}/.ssh`, "/mnt/secrets");
		await link(root, `${home}/.bun`, "/mnt/secrets");
		const plan = discoverToolchain({ home, binaries: [], path: "", root });
		expect(paths(plan)).not.toContain(`${home}/.bun`);
		expect(plan.unresolved.map((u) => u.name)).toContain("~/.bun");
	});

	test("X11: uv and nvm bind only their version and interpreter dirs, never their credential files", async () => {
		const root = await fixture();
		const home = "/users/u";
		await mkdir(join(root, home, ".nvm/versions/node"), { recursive: true });
		await writeFile(join(root, home, ".nvm/.npmrc"), "token");
		await mkdir(join(root, home, ".local/share/uv/python"), {
			recursive: true,
		});
		await mkdir(join(root, home, ".local/share/uv/credentials"), {
			recursive: true,
		});
		await writeFile(
			join(root, home, ".local/share/uv/credentials/credentials.toml"),
			"token",
		);
		const plan = discoverToolchain({ home, binaries: [], path: "", root });
		const p = paths(plan);
		expect(p).toContain(`${home}/.nvm/versions`);
		expect(p).toContain(`${home}/.local/share/uv/python`);
		expect(p).not.toContain(`${home}/.nvm`);
		expect(p).not.toContain(`${home}/.local/share/uv`);
	});

	test("X11: a home-manager style .nix-profile link into the store still binds", async () => {
		const root = await fixture();
		const home = "/users/u";
		await mkdir(join(root, "nix/store/abc-profile/bin"), { recursive: true });
		await link(root, `${home}/.nix-profile`, "/nix/store/abc-profile");
		const plan = discoverToolchain({ home, binaries: [], path: "", root });
		expect(paths(plan)).toContain(`${home}/.nix-profile`);
		expect(plan.unresolved).toEqual([]);
	});

	test("a binary outside every known root is unresolved", async () => {
		const root = await fixture();
		await exe(root, "opt/vendor/bin/tool");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["tool"],
			path: "/opt/vendor/bin",
			root,
		});
		expect(plan.unresolved[0]?.reason).toContain("outside");
	});

	test("bwrap args are read-only binds only, parents first, no nested duplicates", async () => {
		const root = await fixture();
		await exe(root, "usr/bin/git");
		await mkdir(join(root, "usr/lib"), { recursive: true });
		await exe(root, "users/u/.local/bin/uv");
		await exe(root, "users/u/.local/share/uv/tools/x");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["git", "uv"],
			path: "/usr/bin:/users/u/.local/bin",
			root,
		});
		const args = toolchainBwrapArgs(plan);
		expect(
			args.every(
				(a) => a !== "--bind" && a !== "--bind-try" && a !== "--tmpfs",
			),
		).toBe(true);
		for (let i = 0; i < args.length; i += 3) {
			expect(args[i]).toMatch(/^--ro-bind(-try)?$/);
			expect(args[i + 1]).toBe(args[i + 2]);
		}
		expect(paths(plan).filter((p) => p.startsWith("/usr/"))).toEqual([]);
		expect(paths(plan)).toContain("/users/u/.local/share/uv/tools");
	});

	test("a relative or PATH-less name never resolves, and relative PATH entries are ignored", async () => {
		const root = await fixture();
		await exe(root, "work/git");
		const plan = discoverToolchain({
			home: "/users/u",
			binaries: ["git", "../git"],
			path: "work:.",
			root,
		});
		expect(plan.unresolved).toHaveLength(2);
	});

	test("runs against the real filesystem with no root override", () => {
		const plan = discoverToolchain({
			home: "/nonexistent-home",
			binaries: ["sh"],
			path: process.env.PATH ?? "/usr/bin",
		});
		expect(plan.binds.every((b) => b.path !== "/nonexistent-home")).toBe(true);
		expect(plan.binds.length).toBeGreaterThan(0);
	});
});
