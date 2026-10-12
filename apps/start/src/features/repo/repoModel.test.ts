import { describe, expect, test } from "bun:test";

import { href } from "../../routes";
import {
	assignLanes,
	type BranchLike,
	branchBadges,
	describeXY,
	filterBranches,
	formatStat,
	graphWidth,
	isStale,
	kindCounts,
	parseBranchKind,
	parseRepoPath,
	refChips,
	shortRef,
} from "./repoModel";

const NOW = Date.parse("2026-10-12T00:00:00Z");
const DAY = 86_400;

function branch(over: Partial<BranchLike> = {}): BranchLike {
	return {
		name: "feature/x",
		kind: "local",
		isIntegration: false,
		isHead: false,
		ahead: 2,
		behind: 1,
		merged: false,
		lastCommit: {
			author: "Ada",
			time: NOW / 1000 - DAY,
			subject: "work on x",
		},
		mfw: null,
		run: null,
		mergeJob: null,
		...over,
	};
}

describe("deep links round-trip through the parser", () => {
	test("branch names keep their slashes and encode the rest", () => {
		const url = href.repoBranch("mfw", "feature/a b/#1");
		expect(url).toBe("/p/mfw/repo/branches/feature/a%20b/%231");
		const splat = url.slice("/p/mfw/repo/".length);
		expect(parseRepoPath(splat)).toEqual({
			section: "branches",
			branch: "feature/a b/#1",
		});
	});

	test("commit, worktree and compare", () => {
		expect(parseRepoPath("commit/abc123")).toEqual({
			section: "commits",
			sha: "abc123",
		});
		expect(href.repoCommit("mfw", "abc123")).toBe("/p/mfw/repo/commit/abc123");
		expect(parseRepoPath("worktree/01JABC")).toEqual({
			section: "worktrees",
			worktree: "01JABC",
		});
		expect(href.repoCompare("mfw", "main", "mfw/01JABC")).toBe(
			"/p/mfw/repo/compare/main...mfw/01JABC",
		);
		expect(parseRepoPath("compare/main...mfw/01JABC")).toEqual({
			section: "compare",
			a: "main",
			b: "mfw/01JABC",
		});
		expect(parseRepoPath("compare")).toEqual({
			section: "compare",
			a: null,
			b: null,
		});
		expect(href.repoCompare("mfw")).toBe("/p/mfw/repo/compare");
		expect(href.repoCompare("mfw", "a", "b", { mode: "two-dot" })).toBe(
			"/p/mfw/repo/compare/a...b?mode=two-dot",
		);
	});

	test("list sections, and anything unknown lands on Files", () => {
		expect(parseRepoPath("branches")).toEqual({
			section: "branches",
			branch: null,
		});
		expect(parseRepoPath("worktrees")).toEqual({
			section: "worktrees",
			worktree: null,
		});
		expect(parseRepoPath("commits")).toEqual({ section: "commits", sha: null });
		expect(parseRepoPath("")).toEqual({ section: "files" });
		expect(parseRepoPath("files")).toEqual({ section: "files" });
		expect(parseRepoPath("nonsense/here")).toEqual({ section: "files" });
	});

	test("the old Files links point at the new home", () => {
		expect(href.files("mfw")).toBe("/p/mfw/repo/files");
		expect(href.files("mfw", { ref: "main", path: "src" })).toBe(
			"/p/mfw/repo/files?ref=main&path=src",
		);
		expect(href.repo("mfw")).toBe("/p/mfw/repo");
	});
});

describe("ref labels", () => {
	test("run and wip branch names keep a readable head", () => {
		const id = "01JABCDEFGHJKMNPQRSTVWXYZ0";
		expect(shortRef(`mfw/${id}`)).toBe("mfw/01JABC…XYZ0");
		expect(shortRef(`wip/MFW-9-${id}`)).toBe("wip/MFW-9-01JABC…XYZ0");
		expect(shortRef(`wip/MFW-9-${id}-2`)).toBe("wip/MFW-9-01JABC…XYZ0-2");
		expect(shortRef("feature/x")).toBe("feature/x");
	});

	test("decorations: ordered, integration first, redundant remotes folded", () => {
		const chips = refChips(
			[
				{ name: "v1", kind: "tag" },
				{ name: "origin/main", kind: "remote" },
				{ name: "origin/other", kind: "remote" },
				{ name: "topic", kind: "local" },
				{ name: "main", kind: "local" },
				{ name: "HEAD", kind: "head" },
			],
			"main",
		);
		expect(chips.map((c) => c.label)).toEqual([
			"HEAD",
			"main",
			"topic",
			"origin/other",
			"v1",
		]);
		expect(chips.find((c) => c.label === "main")?.tone).toBe("ok");
		expect(chips.find((c) => c.label === "HEAD")?.linkable).toBe(false);
	});
});

describe("branch badges, staleness and filters", () => {
	test("merged vs at base vs stale", () => {
		const keys = (b: BranchLike) => branchBadges(b, NOW).map((x) => x.key);
		expect(keys(branch({ ahead: 0, behind: 3, merged: true }))).toContain(
			"merged",
		);
		const atBase = keys(branch({ ahead: 0, behind: 0, merged: true }));
		expect(atBase).toContain("base");
		expect(atBase).not.toContain("merged");
		const old = branch({
			lastCommit: { author: "A", time: NOW / 1000 - 45 * DAY, subject: "s" },
		});
		expect(isStale(old, NOW)).toBe(true);
		expect(keys(old)).toContain("stale");
		// Merged work is never stale, and neither is the integration branch.
		expect(isStale({ ...old, merged: true }, NOW)).toBe(false);
		expect(isStale({ ...old, isIntegration: true }, NOW)).toBe(false);
	});

	test("mfw ownership and merge state show as badges", () => {
		const b = branch({
			mfw: "run",
			run: { taskId: "MFW-1", live: true, state: "running" },
			mergeJob: { state: "parked" },
		});
		const badges = branchBadges(b, NOW);
		expect(badges.map((x) => x.key)).toEqual(
			expect.arrayContaining(["mfw", "merge", "live"]),
		);
		expect(badges.find((x) => x.key === "merge")).toMatchObject({
			label: "merge parked",
			tone: "critical",
		});
	});

	test("filters combine kind and text terms", () => {
		const all = [
			branch({
				name: "main",
				isIntegration: true,
				ahead: 0,
				behind: 0,
				merged: true,
			}),
			branch({ name: "feature/login", run: null }),
			branch({
				name: "mfw/01JABCDEFGHJKMNPQRSTVWXYZ0",
				mfw: "run",
				run: { taskId: "MFW-12", live: false, state: "completed" },
			}),
			branch({ name: "origin/feature/login", kind: "remote" }),
			branch({
				name: "old/thing",
				lastCommit: {
					author: "Bo",
					time: NOW / 1000 - 90 * DAY,
					subject: "ancient",
				},
			}),
			branch({ name: "done", ahead: 0, merged: true }),
		];
		const names = (kind: Parameters<typeof parseBranchKind>[0], q = "") =>
			filterBranches(all, { kind: parseBranchKind(kind), q, nowMs: NOW }).map(
				(b) => b.name,
			);
		expect(names("remote")).toEqual(["origin/feature/login"]);
		expect(names("mfw")).toEqual(["mfw/01JABCDEFGHJKMNPQRSTVWXYZ0"]);
		expect(names("stale")).toEqual(["old/thing"]);
		expect(names("merged")).toEqual(["done"]);
		expect(names("unmerged")).not.toContain("main");
		expect(names("all", "login")).toEqual([
			"feature/login",
			"origin/feature/login",
		]);
		expect(names("all", "mfw-12")).toEqual(["mfw/01JABCDEFGHJKMNPQRSTVWXYZ0"]);
		expect(names("all", "login remote")).toEqual([]);
		expect(names("nonsense")).toHaveLength(all.length);
		expect(kindCounts(all, NOW).remote).toBe(1);
	});
});

describe("graph lanes", () => {
	const sha = (s: string) => s;

	test("a straight line is one lane", () => {
		const rows = assignLanes([
			{ sha: "c", parents: ["b"] },
			{ sha: "b", parents: ["a"] },
			{ sha: "a", parents: [] },
		]);
		expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
		expect(rows.map((r) => r.parentLanes)).toEqual([[0], [0], []]);
		expect(graphWidth(rows)).toBe(1);
	});

	test("a merge opens a second lane that closes at the fork point", () => {
		// m merges f (feature) into main; both come from base.
		//   m (parents: main-side x, feature-side f)
		//   x
		//   f
		//   base
		const rows = assignLanes([
			{ sha: sha("m"), parents: ["x", "f"] },
			{ sha: sha("x"), parents: ["base"] },
			{ sha: sha("f"), parents: ["base"] },
			{ sha: sha("base"), parents: [] },
		]);
		const [m, x, f, base] = rows;
		expect(m).toMatchObject({ lane: 0, parentLanes: [0, 1] });
		expect(x).toMatchObject({ lane: 0, through: [1], parentLanes: [0] });
		// f sits in the feature lane; its parent `base` is already expected in
		// lane 0, so lane 1 closes into it.
		expect(f).toMatchObject({ lane: 1, through: [0], parentLanes: [0] });
		// base takes lane 0, and no line is left dangling in lane 1.
		expect(base).toMatchObject({ lane: 0, hasChildAbove: true, through: [] });
		expect(graphWidth(rows)).toBe(2);
	});

	test("two children of one commit converge: the extra lane ends at the parent", () => {
		const rows = assignLanes([
			{ sha: "a", parents: ["p"] },
			{ sha: "b", parents: ["p"] },
			{ sha: "p", parents: [] },
		]);
		// `a` takes lane 0 expecting p; `b` has no child above so opens lane 1,
		// but p is already expected in lane 0, so b's line bends into it.
		expect(rows[0]).toMatchObject({ lane: 0, parentLanes: [0] });
		expect(rows[1]).toMatchObject({ lane: 1, parentLanes: [0] });
		expect(rows[2]).toMatchObject({ lane: 0, hasChildAbove: true });
	});

	test("paging: lanes for earlier rows do not change when more rows arrive", () => {
		const log = [
			{ sha: "m", parents: ["x", "f"] },
			{ sha: "x", parents: ["base"] },
			{ sha: "f", parents: ["base"] },
			{ sha: "base", parents: ["root"] },
			{ sha: "root", parents: [] },
		];
		const first = assignLanes(log.slice(0, 3));
		const all = assignLanes(log);
		expect(all.slice(0, 3)).toEqual(first);
	});

	test("an octopus merge fans out to one lane per parent", () => {
		const rows = assignLanes([
			{ sha: "m", parents: ["a", "b", "c"] },
			{ sha: "a", parents: [] },
			{ sha: "b", parents: [] },
			{ sha: "c", parents: [] },
		]);
		expect(rows[0]?.parentLanes).toEqual([0, 1, 2]);
		expect(rows.slice(1).map((r) => r.lane)).toEqual([0, 1, 2]);
	});
});

describe("small formatters", () => {
	test("diff stats and porcelain words", () => {
		expect(formatStat(3, 1)).toEqual({
			added: "+3",
			deleted: "−1",
			binary: false,
		});
		expect(formatStat(null, null).binary).toBe(true);
		expect(describeXY(" ", "M", false)).toBe("modified");
		expect(describeXY("A", "M", false)).toBe(
			"added (staged), modified (unstaged)",
		);
		expect(describeXY("?", "?", true)).toBe("untracked");
		expect(describeXY("U", "U", false)).toContain("conflicted");
	});
});
