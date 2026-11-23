import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addAgentWritableRoots,
	binaryTrustProblem,
	directoryTrustProblem,
	type PathTrustIo,
	pinnedToolIn,
	resetBwrapAvailableCache,
	rootOwnerUids,
} from "../src/sandbox.ts";

type Node =
	| { kind: "dir" | "file"; uid: number; mode: number }
	| { kind: "link"; uid: number; mode: number; target: string };

/** A filesystem where the listed parents are root-owned 0755 unless stated. */
function fakeFs(nodes: Record<string, Node>): PathTrustIo {
	return {
		lstat: (p) => {
			const n = nodes[p];
			if (n) return { kind: n.kind, uid: n.uid, mode: n.mode };
			return Object.keys(nodes).some((k) => k.startsWith(`${p}/`)) || p === "/"
				? { kind: "dir", uid: 0, mode: 0o755 }
				: null;
		},
		readlink: (p) => {
			const n = nodes[p];
			return n?.kind === "link" ? n.target : null;
		},
		realDir: (p) => p,
		rootUids: new Set([0]),
	};
}

const file = (uid = 0, mode = 0o755): Node => ({ kind: "file", uid, mode });
const OWNER = 1000;

describe("a binary is trusted only when nothing an agent can write leads to it", () => {
	test("a root-owned binary in a root-owned tree passes", () => {
		const io = fakeFs({ "/usr/bin/git": file() });
		expect(binaryTrustProblem("/usr/bin/git", [], io)).toBeNull();
	});

	test("the reviewer's case: a project's node_modules/.bin outside $HOME", () => {
		const io = fakeFs({
			"/srv/app": { kind: "dir", uid: OWNER, mode: 0o755 },
			"/srv/app/node_modules/.bin/claude": file(OWNER),
		});
		expect(
			binaryTrustProblem("/srv/app/node_modules/.bin/claude", [], io),
		).not.toBeNull();
	});

	test("the reviewer's case: a 0777 PATH directory", () => {
		const io = fakeFs({
			"/opt/open": { kind: "dir", uid: 0, mode: 0o777 },
			"/opt/open/claude": file(),
		});
		expect(binaryTrustProblem("/opt/open/claude", [], io)).toContain(
			"writable",
		);
	});

	test("a group-writable parent several levels up fails", () => {
		const io = fakeFs({
			"/opt": { kind: "dir", uid: 0, mode: 0o775 },
			"/opt/tool/bin/x": file(),
		});
		expect(binaryTrustProblem("/opt/tool/bin/x", [], io)).not.toBeNull();
	});

	test("a group- or world-writable file fails", () => {
		for (const mode of [0o775, 0o757]) {
			const io = fakeFs({ "/usr/bin/x": file(0, mode) });
			expect(binaryTrustProblem("/usr/bin/x", [], io)).not.toBeNull();
		}
	});

	test("the reviewer's case: a symlink in a trusted directory into $HOME", () => {
		const io = fakeFs({
			"/usr/bin/claude": {
				kind: "link",
				uid: 0,
				mode: 0o777,
				target: "/home/owner/.local/bin/claude",
			},
			"/home/owner": { kind: "dir", uid: OWNER, mode: 0o755 },
			"/home/owner/.local/bin/claude": file(OWNER),
		});
		expect(binaryTrustProblem("/usr/bin/claude", [], io)).not.toBeNull();
	});

	test("every hop of a link chain is checked", () => {
		const io = fakeFs({
			"/usr/bin/a": { kind: "link", uid: 0, mode: 0o777, target: "/opt/w/b" },
			"/opt/w": { kind: "dir", uid: 0, mode: 0o777 },
			"/opt/w/b": { kind: "link", uid: 0, mode: 0o777, target: "/usr/lib/c" },
			"/usr/lib/c": file(),
		});
		expect(binaryTrustProblem("/usr/bin/a", [], io)).not.toBeNull();
	});

	test("a link loop fails rather than hanging", () => {
		const io = fakeFs({
			"/usr/bin/a": { kind: "link", uid: 0, mode: 0o777, target: "/usr/bin/b" },
			"/usr/bin/b": { kind: "link", uid: 0, mode: 0o777, target: "/usr/bin/a" },
		});
		expect(binaryTrustProblem("/usr/bin/a", [], io)).toContain("links");
	});

	test("a link into the store passes, as profiles use", () => {
		const io = fakeFs({
			"/nix/store": { kind: "dir", uid: 0, mode: 0o1775 },
			"/usr/bin/git": {
				kind: "link",
				uid: 0,
				mode: 0o777,
				target: "/nix/store/abc-git/bin/git",
			},
			"/nix/store/abc-git/bin/git": file(0, 0o555),
		});
		expect(binaryTrustProblem("/usr/bin/git", [], io)).toBeNull();
	});

	test("the sticky-group exception is for /nix/store and nothing else", () => {
		const sticky = { kind: "dir" as const, uid: 0, mode: 0o1775 };
		expect(
			directoryTrustProblem("/nix/store", [], fakeFs({ "/nix/store": sticky })),
		).toBeNull();
		expect(
			directoryTrustProblem("/opt/x", [], fakeFs({ "/opt/x": sticky })),
		).not.toBeNull();
		expect(
			directoryTrustProblem(
				"/nix/store",
				[],
				fakeFs({ "/nix/store": { ...sticky, mode: 0o1777 } }),
			),
		).not.toBeNull();
		expect(
			directoryTrustProblem(
				"/nix/store",
				[],
				fakeFs({ "/nix/store": { ...sticky, uid: OWNER } }),
			),
		).not.toBeNull();
	});

	test("a listed agent-writable root is refused even when root-owned", () => {
		const io = fakeFs({ "/var/tmp/x": file(), "/dev/shm/y": file() });
		expect(binaryTrustProblem("/var/tmp/x", ["/var/tmp"], io)).not.toBeNull();
		expect(binaryTrustProblem("/dev/shm/y", ["/dev/shm"], io)).not.toBeNull();
	});
});

describe("which uids count as root", () => {
	test("uid 0, plus the overflow uid only when 0 is unmapped here", () => {
		expect([...rootOwnerUids("0 0 4294967295\n", "65534\n", 1000)]).toEqual([
			0,
		]);
		expect(
			[...rootOwnerUids("1000 0 1\n", "65534\n", 1000)].sort((a, b) => a - b),
		).toEqual([0, 65534]);
	});

	test("this process's own uid never counts as root", () => {
		expect([...rootOwnerUids("1000 0 1\n", "1000\n", 1000)]).toEqual([0]);
	});

	test("an unreadable map trusts uid 0 only", () => {
		expect([...rootOwnerUids(undefined, "65534\n", 1000)]).toEqual([0]);
	});
});

describe("on the real filesystem", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		resetBwrapAvailableCache();
	});
	const tmp = () => {
		const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-trust-")));
		dirs.push(d);
		return d;
	};

	test("our own directory is refused even when not on a writable-root list", () => {
		const d = tmp();
		const bin = join(d, "bin");
		mkdirSync(bin);
		const tool = join(bin, "fake-tool");
		writeFileSync(tool, "#!/bin/sh\n");
		chmodSync(tool, 0o755);
		expect(pinnedToolIn("fake-tool", bin, [])).toBeNull();
	});

	test("a planted link to a real system tool is refused too", () => {
		const d = tmp();
		symlinkSync("/bin/sh", join(d, "sh"));
		expect(pinnedToolIn("sh", d, [])).toBeNull();
	});

	test("a configured project root stays excluded", () => {
		const io = fakeFs({ "/srv/proj/bin/git": file() });
		addAgentWritableRoots(["/srv/proj"]);
		expect(pinnedToolIn("git", "/srv/proj/bin", undefined, io)).toBeNull();
	});
});
