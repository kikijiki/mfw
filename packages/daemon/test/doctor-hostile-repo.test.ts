import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
	readBoardLayout,
	readProtectedBoardPaths,
} from "../src/board-layout.ts";
import { MAX_PROJECT_FILE_BYTES } from "../src/containment/safe-file.ts";
import { liveDoctorProbes, withDeadline } from "../src/doctor/live-probes.ts";
import {
	discoverGitDirs,
	repoConfigRefusal,
} from "../src/host-git/repo-config.ts";
import { requireHostTool } from "../src/sandbox.ts";
import { loadTriggerDefs } from "../src/triggers/def.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-hostile-")));
	dirs.push(d);
	return d;
};
const log = pino({ level: "silent" });
const mkfifo = (path: string) => {
	const p = Bun.spawnSync([requireHostTool("mkfifo"), path]);
	expect(p.exitCode).toBe(0);
};
const sparse = (path: string, bytes: number) => {
	const fd = openSync(path, "w");
	ftruncateSync(fd, bytes);
	closeSync(fd);
};
const GOOD =
	"---\nid: good\non: merge.completed\naction: script\nrun: ./deploy.sh\n---\n";

describe("a trigger definition cannot exhaust or hang the host", () => {
	test("a symlink to a 400 MB file is quarantined without reading it", async () => {
		const d = tmp();
		const big = join(d, "big");
		sparse(big, 400 * 1024 * 1024);
		const triggers = join(d, "triggers");
		mkdirSync(triggers);
		symlinkSync(big, join(triggers, "evil.md"));
		writeFileSync(join(triggers, "good.md"), GOOD);
		const before = process.memoryUsage().rss;
		const r = await loadTriggerDefs(triggers, log);
		expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
		expect(r.quarantined.map((q) => q.file)).toEqual(["evil.md"]);
		expect(r.defs.map((x) => x.id)).toEqual(["good"]);
	}, 8_000);

	test("a symlink to a device is quarantined", async () => {
		const triggers = tmp();
		symlinkSync("/dev/zero", join(triggers, "evil.md"));
		const r = await loadTriggerDefs(triggers, log);
		expect(r.quarantined).toHaveLength(1);
	}, 4_000);

	test("a FIFO is quarantined at once", async () => {
		const triggers = tmp();
		mkfifo(join(triggers, "evil.md"));
		const r = await loadTriggerDefs(triggers, log);
		expect(r.quarantined.map((q) => q.file)).toEqual(["evil.md"]);
	}, 4_000);

	test("a regular file over the limit is quarantined", async () => {
		const triggers = tmp();
		sparse(join(triggers, "big.md"), MAX_PROJECT_FILE_BYTES + 1);
		const r = await loadTriggerDefs(triggers, log);
		expect(r.quarantined.map((q) => q.file)).toEqual(["big.md"]);
	}, 4_000);
});

describe("the board location cannot exhaust or hang the host", () => {
	const location = (root: string) => {
		const state = join(root, ".mfw", "state");
		mkdirSync(state, { recursive: true });
		return join(state, "board-location.json");
	};

	test("a FIFO reads as no record, and protection stays on the defaults", async () => {
		const root = tmp();
		mkfifo(location(root));
		expect(await readBoardLayout(root)).toBeNull();
		expect((await readProtectedBoardPaths(root)).length).toBeGreaterThan(0);
	}, 4_000);

	test("a symlink to a large file reads as no record", async () => {
		const root = tmp();
		const big = join(root, "big");
		sparse(big, 400 * 1024 * 1024);
		symlinkSync(big, location(root));
		const before = process.memoryUsage().rss;
		expect(await readBoardLayout(root)).toBeNull();
		expect((await readProtectedBoardPaths(root)).length).toBeGreaterThan(0);
		expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
	}, 8_000);
});

describe("git discovery cannot hang the host", () => {
	test("a FIFO at .git does not block", () => {
		const root = tmp();
		mkfifo(join(root, ".git"));
		expect(discoverGitDirs(root)?.gitDir ?? null).not.toBe(join(root, ".git"));
	}, 4_000);

	test("a FIFO at .git/commondir does not block", () => {
		const root = tmp();
		mkdirSync(join(root, ".git"));
		mkfifo(join(root, ".git", "commondir"));
		expect(discoverGitDirs(root)?.commonDir).toBe(join(root, ".git"));
	}, 4_000);

	test("a FIFO at .git/config is a refusal, quickly", async () => {
		const root = tmp();
		mkdirSync(join(root, ".git"));
		mkfifo(join(root, ".git", "config"));
		const started = Date.now();
		expect(await repoConfigRefusal(root)).not.toBeNull();
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 4_000);
});

describe("each project probe has a deadline", () => {
	test("a probe that never finishes is rejected", async () => {
		await expect(
			withDeadline(new Promise(() => {}), 20, "the project"),
		).rejects.toThrow("did not finish");
	});

	test("a finished probe keeps its value", async () => {
		expect(await withDeadline(Promise.resolve(7), 1000, "x")).toBe(7);
	});

	test("the live project probe uses it", async () => {
		const root = tmp();
		mkdirSync(join(root, ".git"));
		const probes = liveDoctorProbes({
			env: { PATH: "" },
			home: join(root, "home"),
			installRoot: root,
			projectDeadlineMs: 0,
		});
		await expect(probes.project({ name: "x", root })).rejects.toThrow(
			"did not finish",
		);
	});
});
