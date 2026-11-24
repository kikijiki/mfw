import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HostGit,
	HostGitError,
	type SeedProtocol,
} from "../src/host-git/runner.ts";
import {
	planSubmoduleSeeds,
	seedSubmodules,
} from "../src/host-git/submodules.ts";
import { commitSpec, git, newBareRepo } from "./fixtures/hostile-tree.ts";
import { plainGit } from "./fixtures/tampered-clone.ts";

const dirs: string[] = [];
const daemons: { kill: () => void }[] = [];
afterEach(async () => {
	for (const d of daemons.splice(0)) d.kill();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const SHA = "a".repeat(40);
const ALLOWED = "https://example.invalid/org/lib.git";

async function layout(
	extra: Partial<ConstructorParameters<typeof HostGit>[0]> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "mfw-seed-"));
	dirs.push(root);
	const workspaceRoot = join(root, "ws");
	const scratchRoot = join(root, "scratch");
	const primary = join(root, "primary.git");
	await mkdir(workspaceRoot);
	await mkdir(scratchRoot);
	await plainGit(["init", "--bare", "-q", primary], root);
	const target = join(scratchRoot, "seed.git");
	await plainGit(["init", "--bare", "-q", target], root);
	const host = new HostGit({
		workspaceRoot,
		ownedRoots: [scratchRoot],
		submoduleAllowlist: [
			ALLOWED,
			"git://git.example.invalid/*",
			"ssh://git@ok.example.invalid/*",
		],
		sshBin: "/usr/bin/ssh",
		...extra,
	});
	return { root, workspaceRoot, scratchRoot, primary, target, host };
}

type L = Awaited<ReturnType<typeof layout>>;

function seed(
	l: L,
	url: string,
	spec: string,
	protocol: SeedProtocol | string,
	over: { repo?: string; extra?: string[]; allowFile?: boolean } = {},
) {
	return l.host.run(
		["fetch", "--no-tags", ...(over.extra ?? []), "--", url, spec],
		{
			cwd: l.scratchRoot,
			repo: over.repo ?? l.target,
			allowProtocol: protocol as SeedProtocol,
			...(over.allowFile ? { allowFile: true } : {}),
		},
	);
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof HostGitError) return e.code;
		throw e;
	}
	return "none";
}

const GOOD = `+${SHA}:refs/mfw/submodule/s1`;

describe("seed fetch refusals (nothing runs)", () => {
	test("a url that is not on the allowlist", async () => {
		const l = await layout();
		expect(
			await code(seed(l, "https://other.invalid/org/lib.git", GOOD, "https")),
		).toBe("bad_argument");
		expect(
			await code(
				seed(l, "https://example.invalid/org/other.git", GOOD, "https"),
			),
		).toBe("bad_argument");
	});

	test("ssh to an unallowlisted host, and ssh without sshBin", async () => {
		const l = await layout();
		expect(
			await code(seed(l, "ssh://git@evil.example.invalid/x.git", GOOD, "ssh")),
		).toBe("bad_argument");
		expect(
			await code(seed(l, "git@evil.example.invalid:x.git", GOOD, "ssh")),
		).toBe("bad_argument");
		const none = await layout({ sshBin: undefined as unknown as string });
		expect(
			await code(seed(none, "ssh://git@ok.example.invalid/x.git", GOOD, "ssh")),
		).toBe("bad_argument");
	});

	test("file:, ext:: and local paths, even when allowlisted", async () => {
		const l = await layout({
			submoduleAllowlist: [
				"file:///etc/*",
				"ext::sh -c id",
				"/srv/repo",
				"http://h/x",
			],
		});
		for (const [url, p] of [
			["file:///etc/passwd", "https"],
			["ext::sh -c id", "https"],
			["/srv/repo", "https"],
			["http://h/x", "https"],
			["file:///etc/passwd", "file"],
			["ext::sh -c id", "ext"],
			["http://h/x", "http"],
		] as const) {
			expect(await code(seed(l, url, GOOD, p))).toBe("bad_argument");
		}
	});

	test("a dash url, with and without the `--`", async () => {
		const l = await layout({
			submoduleAllowlist: ["-u./x", "--upload-pack=x"],
		});
		for (const url of ["-u./x", "--upload-pack=touch x"]) {
			// behind the `--` it is an operand, and the url shape refuses it
			expect(await code(seed(l, url, GOOD, "https"))).toBe("bad_argument");
			// without it the runner refuses the missing `--` first
			expect(
				await code(
					l.host.run(["fetch", url, GOOD], {
						cwd: l.scratchRoot,
						repo: l.target,
						allowProtocol: "https",
					}),
				),
			).toMatch(/bad_argument|option_injection/);
		}
	});

	test("a scheme that does not match the url", async () => {
		const l = await layout();
		expect(await code(seed(l, ALLOWED, GOOD, "git"))).toBe("bad_argument");
		expect(
			await code(seed(l, "git://git.example.invalid/a.git", GOOD, "https")),
		).toBe("bad_argument");
	});

	test("a sha that is not 40 lower-case hex", async () => {
		const l = await layout();
		for (const sha of [
			"a".repeat(39),
			"a".repeat(41),
			"A".repeat(40),
			"g".repeat(40),
			"HEAD",
			"main",
		]) {
			expect(
				await code(seed(l, ALLOWED, `+${sha}:refs/mfw/submodule/s1`, "https")),
			).toBe("bad_argument");
		}
	});

	test("a branch-name or wide refspec", async () => {
		const l = await layout();
		for (const spec of [
			"+refs/heads/main:refs/mfw/submodule/s1",
			"+refs/heads/*:refs/mfw/submodule/*",
			`${SHA}:refs/mfw/submodule/s1`,
			`+${SHA}:refs/heads/main`,
			`+${SHA}:refs/mfw/quarantine/s1`,
			`+${SHA}:refs/mfw/submodule/../x`,
			`+${SHA}:refs/mfw/submodule/s1/../../x`,
			`+${SHA}:refs/mfw/submodule/-x`,
			`+${SHA}:refs/mfw/submodule/`,
			`+${SHA}:refs/mfw/submodule/a b`,
		]) {
			expect(await code(seed(l, ALLOWED, spec, "https"))).toBe("bad_argument");
		}
	});

	test("two refspecs, or none", async () => {
		const l = await layout();
		expect(
			await code(
				l.host.run(
					["fetch", "--", ALLOWED, GOOD, `+${SHA}:refs/mfw/submodule/s2`],
					{ cwd: l.scratchRoot, repo: l.target, allowProtocol: "https" },
				),
			),
		).toBe("bad_argument");
		expect(
			await code(
				l.host.run(["fetch", "--", ALLOWED], {
					cwd: l.scratchRoot,
					repo: l.target,
					allowProtocol: "https",
				}),
			),
		).toBe("bad_argument");
	});

	test("a target under the workspace root, or a repo that is not scratch", async () => {
		const l = await layout();
		const inWs = join(l.workspaceRoot, "planted.git");
		await plainGit(["init", "--bare", "-q", inWs], l.root);
		expect(await code(seed(l, ALLOWED, GOOD, "https", { repo: inWs }))).toBe(
			"path_under_workspace",
		);
		expect(
			await code(seed(l, ALLOWED, GOOD, "https", { repo: l.primary })),
		).toBe("bad_argument");
	});

	test("allowProtocol with allowFile, on another subcommand, or with a bad protocol", async () => {
		const l = await layout();
		expect(
			await code(seed(l, ALLOWED, GOOD, "https", { allowFile: true })),
		).toBe("bad_argument");
		expect(
			await code(
				l.host.run(["for-each-ref"], {
					cwd: l.scratchRoot,
					repo: l.target,
					allowProtocol: "https",
				}),
			),
		).toBe("bad_argument");
		expect(await code(seed(l, ALLOWED, GOOD, "ftp"))).toBe("bad_argument");
	});

	test("seed refspecs are refused without allowProtocol, and urls too", async () => {
		const l = await layout();
		expect(
			await code(
				l.host.run(["fetch", "--", l.primary, GOOD], {
					cwd: l.scratchRoot,
					repo: l.target,
					allowFile: true,
				}),
			),
		).toBe("bad_argument");
		expect(
			await code(
				l.host.run(
					["fetch", "--", ALLOWED, "+refs/heads/mfw/r1:refs/mfw/run/head"],
					{ cwd: l.scratchRoot, repo: l.target },
				),
			),
		).not.toBe("none");
	});

	test("an empty allowlist allows nothing", async () => {
		const l = await layout({ submoduleAllowlist: [] });
		expect(await code(seed(l, ALLOWED, GOOD, "https"))).toBe("bad_argument");
	});

	test("an unlisted option is still refused", async () => {
		const l = await layout();
		expect(
			await code(
				seed(l, ALLOWED, GOOD, "https", { extra: ["--upload-pack=touch x"] }),
			),
		).toBe("option_injection");
		expect(
			await code(seed(l, ALLOWED, GOOD, "https", { extra: ["--depth=1"] })),
		).toBe("option_injection");
	});
});

describe("seed fetch transport config", () => {
	async function recorded(protocol: SeedProtocol, url: string) {
		const bin = await mkdtemp(join(tmpdir(), "mfw-fakegit-"));
		dirs.push(bin);
		const out = join(bin, "out.txt");
		const fake = join(bin, "git");
		await writeFile(
			fake,
			`#!/bin/sh\n{ for a in "$@"; do echo "ARG:$a"; done; echo "SSH:$GIT_SSH_COMMAND"; ulimit -v; } > ${out}\nexit 0\n`,
		);
		await chmod(fake, 0o755);
		const l = await layout({ gitBin: fake, submoduleAllowlist: [url] });
		const r = await seed(l, url, GOOD, protocol);
		expect(r.exitCode).toBe(0);
		return (await readFile(out, "utf8")).split("\n");
	}

	test("enables only the one scheme, no file, no redirects", async () => {
		const lines = await recorded("https", ALLOWED);
		const c = lines
			.filter((_, i) => lines[i - 1] === "ARG:-c")
			.map((x) => x.slice(4));
		expect(c).toContain("protocol.https.allow=always");
		expect(c).toContain("protocol.allow=never");
		expect(c).toContain("http.followRedirects=false");
		expect(c).toContain("transfer.fsckObjects=true");
		expect(c.filter((x) => /^protocol\.\w+\.allow=always$/.test(x))).toEqual([
			"protocol.https.allow=always",
		]);
		expect(lines).toContain("SSH:false");
		// the memory cap is still applied
		expect(Number(lines[lines.length - 2])).toBeGreaterThan(0);
	});

	test("ssh gets a batch-mode ssh command, git does not get ssh", async () => {
		const ssh = await recorded("ssh", "ssh://git@ok.example.invalid/x.git");
		expect(ssh.find((x) => x.startsWith("SSH:"))).toContain(
			"/usr/bin/ssh -F /dev/null -o BatchMode=yes",
		);
		const g = await recorded("git", "git://git.example.invalid/x.git");
		expect(g).toContain("SSH:false");
		expect(g).toContain("ARG:protocol.git.allow=always");
	});
});

async function startDaemon(
	base: string,
): Promise<{ port: number } | undefined> {
	const port = 20000 + Math.floor(Math.random() * 20000);
	const p = Bun.spawn(
		[
			"git",
			"daemon",
			`--base-path=${base}`,
			"--export-all",
			"--listen=127.0.0.1",
			`--port=${port}`,
			base,
		],
		{
			stdout: "ignore",
			stderr: "ignore",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: "/nonexistent",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		},
	);
	daemons.push({ kill: () => p.kill() });
	for (let i = 0; i < 50; i++) {
		if (p.exitCode !== null) return undefined;
		try {
			const s = await Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: {
					data() {},
					open(s) {
						s.end();
					},
				},
			});
			void s;
			return { port };
		} catch {
			await Bun.sleep(100);
		}
	}
	return undefined;
}

describe("seedSubmodules against a real git:// server", () => {
	test("fetches the recorded sha into a scratch bare repo, with no checkout", async () => {
		const served = await mkdtemp(join(tmpdir(), "mfw-served-"));
		dirs.push(served);
		const lib = join(served, "lib.git");
		await plainGit(["init", "--bare", "-q", lib], served);
		await git(lib, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
		const libSha = await commitSpec(
			lib,
			{ "lib.txt": "lib\n" },
			{ ref: "refs/heads/main" },
		);
		const srv = await startDaemon(served);
		if (!srv) {
			console.log("skip: git daemon is not available");
			return;
		}
		const url = `git://127.0.0.1:${srv.port}/lib.git`;
		const l = await layout({ submoduleAllowlist: [url] });

		// the primary's base commit records the submodule
		const { root, repo } = await newBareRepo();
		dirs.push(root);
		const baseSha = await commitSpec(repo, {
			"README.md": "x",
			".gitmodules": `[submodule "lib"]\n\tpath = lib\n\turl = ${url}\n`,
			lib: { mode: "160000", sha: libSha },
		});
		const hostForPlan = new HostGit({
			workspaceRoot: l.workspaceRoot,
			ownedRoots: [root, l.scratchRoot],
			submoduleAllowlist: [url],
		});
		const plan = await planSubmoduleSeeds({
			host: hostForPlan,
			primaryRepo: repo,
			baseSha,
			allowlist: [url],
		});
		expect(plan.refusals).toEqual([]);

		const seeded = await seedSubmodules({
			host: l.host,
			plan,
			scratchRoot: l.scratchRoot,
		});
		expect(seeded).toHaveLength(1);
		const s = seeded[0] as (typeof seeded)[number];
		expect(await git(s.bareRepo, ["rev-parse", s.ref])).toBe(libSha);
		expect(s.bareRepo.startsWith(l.scratchRoot)).toBe(true);
		// a bare repo: no work tree was created
		expect(await git(s.bareRepo, ["rev-parse", "--is-bare-repository"])).toBe(
			"true",
		);
	});

	test("a sha the server does not have fails the seed", async () => {
		const served = await mkdtemp(join(tmpdir(), "mfw-served-"));
		dirs.push(served);
		const lib = join(served, "lib.git");
		await plainGit(["init", "--bare", "-q", lib], served);
		await git(lib, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
		await commitSpec(lib, { "lib.txt": "lib\n" }, { ref: "refs/heads/main" });
		const srv = await startDaemon(served);
		if (!srv) return;
		const url = `git://127.0.0.1:${srv.port}/lib.git`;
		const l = await layout({ submoduleAllowlist: [url] });
		const plan = {
			refusals: [],
			seeds: [
				{
					scheme: "git" as const,
					protocolOverride: "protocol.git.allow=always",
					entry: { name: "lib", path: "lib", url, sha: "b".repeat(40) },
				},
			],
		};
		await expect(
			seedSubmodules({ host: l.host, plan, scratchRoot: l.scratchRoot }),
		).rejects.toMatchObject({ code: "fetch_failed" });
	});

	test("refuses to seed a plan that has refusals", async () => {
		const l = await layout();
		await expect(
			seedSubmodules({
				host: l.host,
				scratchRoot: l.scratchRoot,
				plan: {
					seeds: [],
					refusals: [{ name: "x", code: "not_allowlisted", detail: "d" }],
				},
			}),
		).rejects.toMatchObject({ code: "validation" });
	});
});
