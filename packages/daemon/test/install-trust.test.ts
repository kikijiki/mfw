import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type InstallLaunchCheckDeps,
	installLaunchCheck,
} from "../src/containment/install-launch-check.ts";
import {
	INSTALL_MANIFEST,
	INSTALL_MANIFEST_VERSION,
	type InstallManifest,
	sha256OfFile,
	treeDigest,
} from "../src/containment/install-manifest.ts";
import {
	ACK_UNTRUSTED_INSTALL,
	installTrustProblems,
} from "../src/containment/install-trust.ts";
import type { PathTrustIo } from "../src/sandbox.ts";

/**
 * Security review REL-1 M2: the manifest proves the parts belong together, not
 * that agents cannot rewrite them. These pin down the location rule.
 */

let root: string;
let prefix: string;
let libDir: string;
let manifest: InstallManifest;

/** The real filesystem, with every owner reported as root (a root-owned install). */
function ownedBy(uid: (path: string) => number, writable = false): PathTrustIo {
	return {
		lstat: (p) => {
			try {
				const st = lstatSync(p);
				return {
					kind: st.isSymbolicLink()
						? "link"
						: st.isDirectory()
							? "dir"
							: st.isFile()
								? "file"
								: "other",
					uid: uid(p),
					mode: writable ? st.mode | 0o020 : st.mode & ~0o022,
				};
			} catch {
				return null;
			}
		},
		readlink: (p) => {
			try {
				return readlinkSync(p);
			} catch {
				return null;
			}
		},
		realDir: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return null;
			}
		},
		rootUids: new Set([0]),
	};
}
const asRoot = ownedBy(() => 0);

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-install-trust-")));
	prefix = join(root, "opt/mfw");
	libDir = join(prefix, "lib/mfw");
	for (const d of [
		"bin",
		"lib/mfw/server",
		"lib/mfw/public",
		"lib/mfw/runtime",
	]) {
		mkdirSync(join(prefix, d), { recursive: true });
	}
	const write = (rel: string, text: string, mode = 0o444) => {
		writeFileSync(join(prefix, rel), text);
		chmodSync(join(prefix, rel), mode);
	};
	write("bin/mfw", "mfw", 0o555);
	write("bin/mfw-board", "board", 0o555);
	write("lib/mfw/runtime/bun", "bun", 0o555);
	write("lib/mfw/server/index.mjs", "// server");
	write("lib/mfw/THIRD_PARTY_NOTICES.txt", "n");
	manifest = {
		version: INSTALL_MANIFEST_VERSION,
		kind: "compiled",
		mfw: {
			path: "../../bin/mfw",
			sha256: sha256OfFile(join(prefix, "bin/mfw")),
		},
		mfwBoard: {
			path: "../../bin/mfw-board",
			sha256: sha256OfFile(join(prefix, "bin/mfw-board")),
		},
		runtime: {
			path: "runtime/bun",
			sha256: sha256OfFile(join(libDir, "runtime/bun")),
			bunVersion: "1.3.13",
		},
		server: { digest: treeDigest(libDir) },
	};
	writeFileSync(join(libDir, INSTALL_MANIFEST), JSON.stringify(manifest));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("whether agents can write the install", () => {
	test("a root-owned prefix with nothing writable passes", () => {
		expect(
			installTrustProblems(prefix, libDir, manifest, {
				io: asRoot,
				writableRoots: [],
			}),
		).toEqual([]);
	});

	test("a prefix this user owns fails: any process of the user could rewrite it", () => {
		const problems = installTrustProblems(prefix, libDir, manifest, {
			writableRoots: [],
		});
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join("\n")).toContain("is not owned by root");
	});

	test("a prefix inside an agent-writable tree fails, even root-owned", () => {
		const problems = installTrustProblems(prefix, libDir, manifest, {
			io: asRoot,
			writableRoots: [root],
		});
		expect(problems.join("\n")).toContain("in a directory agents can write");
	});

	test("a group-writable file or directory fails", () => {
		const problems = installTrustProblems(prefix, libDir, manifest, {
			io: ownedBy(() => 0, true),
			writableRoots: [],
		});
		expect(problems.join("\n")).toContain("group- or world-writable");
	});

	test("one user-owned file deep in the bundle fails", () => {
		const chunk = join(libDir, "server/index.mjs");
		const problems = installTrustProblems(prefix, libDir, manifest, {
			io: ownedBy((p) => (p === chunk ? 1000 : 0)),
			writableRoots: [],
		});
		expect(problems).toEqual([`lib/mfw: ${chunk} is not owned by root`]);
	});

	test("a runtime recorded in place in a user directory fails", () => {
		const home = join(root, "home/u/.bun/bin");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "bun"), "bun");
		const elsewhere = {
			...manifest,
			runtime: { ...manifest.runtime, path: join(home, "bun") },
		};
		const problems = installTrustProblems(prefix, libDir, elsewhere, {
			io: ownedBy((p) => (p.startsWith(join(root, "home")) ? 1000 : 0)),
			writableRoots: [],
		});
		expect(problems.join("\n")).toContain("runtime:");
	});
});

describe("the launcher's check of its own install", () => {
	const deps = (
		over: Partial<InstallLaunchCheckDeps> = {},
	): InstallLaunchCheckDeps => ({
		compiled: true,
		self: join(prefix, "bin/mfw"),
		acknowledged: async () => undefined,
		expected: {},
		trust: { writableRoots: [] },
		...over,
	});

	test("from source or a bundle there is nothing to check", async () => {
		expect(
			await installLaunchCheck("autonomous", deps({ compiled: false })),
		).toEqual({
			refusal: null,
			warning: null,
		});
	});

	test("an untrusted prefix refuses autonomous launches, with the exact fix", async () => {
		const r = await installLaunchCheck("autonomous", deps());
		expect(r.refusal).toContain("refusing an autonomous launch");
		expect(r.refusal).toContain(
			`"${ACK_UNTRUSTED_INSTALL}": ${JSON.stringify(prefix)}`,
		);
		expect(r.refusal).toContain("--no-same-owner");
	});

	test("an interactive launch goes ahead with a warning", async () => {
		const r = await installLaunchCheck("interactive", deps());
		expect(r.refusal).toBeNull();
		expect(r.warning).toContain("could be changed by agents");
	});

	test("the owner's acknowledgement of exactly this prefix lets it through, still warned", async () => {
		const ok = await installLaunchCheck(
			"autonomous",
			deps({ acknowledged: async () => prefix }),
		);
		expect(ok.refusal).toBeNull();
		expect(ok.warning).toContain(`accepted by ${ACK_UNTRUSTED_INSTALL}`);
		const other = await installLaunchCheck(
			"autonomous",
			deps({ acknowledged: async () => "/opt/other" }),
		);
		expect(other.refusal).toContain("refusing an autonomous launch");
	});

	test("a trusted prefix launches without a word", async () => {
		expect(
			await installLaunchCheck(
				"autonomous",
				deps({ trust: { io: asRoot, writableRoots: [] } }),
			),
		).toEqual({ refusal: null, warning: null });
	});

	test("hashes are checked at every launch: a part changed after start refuses, acknowledged or not", async () => {
		const trusted = deps({
			trust: { io: asRoot, writableRoots: [] },
			acknowledged: async () => prefix,
		});
		expect(
			(await installLaunchCheck("autonomous", trusted)).refusal,
		).toBeNull();
		chmodSync(join(libDir, "server/index.mjs"), 0o644);
		writeFileSync(join(libDir, "server/index.mjs"), "// swapped after start");
		const r = await installLaunchCheck("interactive", trusted);
		expect(r.refusal).toContain("the install does not verify");
		expect(r.refusal).toContain("server: the bundle does not match");
	});

	test("a manifest rewritten for another mfw-board than the one built in is refused", async () => {
		const r = await installLaunchCheck(
			"interactive",
			deps({ expected: { board: "f".repeat(64) } }),
		);
		expect(r.refusal).toContain("another mfw-board");
	});

	test("a standalone mfw runs no agents", async () => {
		rmSync(join(libDir, INSTALL_MANIFEST));
		expect((await installLaunchCheck("interactive", deps())).refusal).toContain(
			"no install around it",
		);
	});
});
