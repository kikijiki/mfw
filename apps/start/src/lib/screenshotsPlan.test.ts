import { describe, expect, test } from "bun:test";
import { BOARD_TEMPLATES } from "@mfw/daemon/board-templates";
import {
	buildManifest,
	DEFAULT_OUT,
	fileName,
	parseAgo,
	parseArgs,
	placeholdersOf,
	resolvePath,
	SECTIONS,
	type SeedPlan,
	selectSections,
	sizesFor,
	TEMPLATE_STATUSES,
	UsageError,
	validateSections,
	validateSeedPlan,
} from "../../../../tools/screenshots/plan.ts";
import { SEED_PLAN } from "../../../../tools/screenshots/seedPlan.ts";

describe("screenshots: CLI", () => {
	test("defaults: one dark 1440x900 pass at 2x", () => {
		const o = parseArgs([]);
		expect(o.sizes).toEqual([{ w: 1440, h: 900 }]);
		expect(o.scale).toBe(2);
		expect(o.themes).toEqual(["dark"]);
		expect(o.only).toEqual([]);
		expect(o.dryRun).toBe(false);
		// no --out: the script writes into the repo's tracked docs/screenshots
		expect(o.out).toBeNull();
		expect(DEFAULT_OUT).toBe("docs/screenshots");
	});

	test("every flag, in both `--k v` and `--k=v` forms", () => {
		const o = parseArgs([
			"--sizes",
			"1920x1080,390x844",
			"--scale=1",
			"--theme",
			"both",
			"--only",
			"home, board",
			"--out=/tmp/x",
			"--publish-dir",
			"/tmp/site",
			"--dry-run",
		]);
		expect(o.sizes.map((s) => `${s.w}x${s.h}`)).toEqual([
			"1920x1080",
			"390x844",
		]);
		expect(o.scale).toBe(1);
		expect(o.themes).toEqual(["dark", "light"]);
		expect(o.only).toEqual(["home", "board"]);
		expect(o.out).toBe("/tmp/x");
		expect(o.publishDir).toBe("/tmp/site");
		expect(o.dryRun).toBe(true);
	});

	test("bad input is a usage error", () => {
		expect(() => parseArgs(["--nope"])).toThrow(UsageError);
		expect(() => parseArgs(["--theme", "sepia"])).toThrow(UsageError);
		expect(() => parseArgs(["--sizes", "big"])).toThrow(UsageError);
		expect(() => parseArgs(["--scale", "9"])).toThrow(UsageError);
		expect(() => parseArgs(["--only"])).toThrow(UsageError);
		expect(() => parseArgs(["stray"])).toThrow(UsageError);
	});

	test("--only picks sections and names the unknown ones", () => {
		expect(selectSections(["home"]).map((s) => s.name)).toEqual(["home"]);
		expect(() => selectSections(["home", "nope"])).toThrow(/nope/);
	});

	test("phone sections keep their own size; the rest follow --sizes", () => {
		const requested = [{ w: 1920, h: 1080 }];
		const phone = SECTIONS.find((s) => s.name === "phone-home");
		const board = SECTIONS.find((s) => s.name === "board");
		expect(sizesFor(phone as never, requested)).toEqual([{ w: 390, h: 844 }]);
		expect(sizesFor(board as never, requested)).toEqual(requested);
	});
});

describe("screenshots: names and manifest", () => {
	test("file names are deterministic", () => {
		expect(fileName("board", "dark", { w: 1440, h: 900 })).toBe(
			"board-dark-1440x900.png",
		);
	});

	test("the manifest is sorted and keeps skips", () => {
		const entry = (name: string, theme: "dark" | "light") => ({
			name,
			title: name,
			path: `${name}-${theme}-1440x900.png`,
			file: `${name}-${theme}-1440x900.png`,
			viewport: { w: 1440, h: 900 },
			scale: 2,
			theme,
			route: `/${name}`,
		});
		const m = buildManifest({
			generatedAt: "2026-10-12T00:00:00.000Z",
			commit: "abc1234",
			scale: 2,
			themes: ["dark", "light"],
			screenshots: [
				entry("home", "light"),
				entry("board", "dark"),
				entry("home", "dark"),
			],
			skipped: [
				{ name: "repo", title: "Repo", reason: "not available in this build" },
				{ name: "docs", title: "Docs", reason: "not available in this build" },
			],
		});
		expect(m.screenshots.map((e) => e.file)).toEqual([
			"board-dark-1440x900.png",
			"home-dark-1440x900.png",
			"home-light-1440x900.png",
		]);
		expect(m.skipped.map((s) => s.name)).toEqual(["docs", "repo"]);
		expect(m.commit).toBe("abc1234");
	});
});

describe("screenshots: seed plan", () => {
	test("the shipped plan and section list are valid", () => {
		expect(validateSeedPlan(SEED_PLAN)).toEqual([]);
		expect(validateSections(SECTIONS, SEED_PLAN)).toEqual([]);
	});

	test("the template statuses match the daemon's templates", () => {
		for (const t of BOARD_TEMPLATES) {
			if (t.id in TEMPLATE_STATUSES) {
				expect(
					TEMPLATE_STATUSES[t.id as keyof typeof TEMPLATE_STATUSES],
				).toEqual(t.statuses);
			}
		}
	});

	test("the plan covers every status, a parent with children, dependencies and live runs", () => {
		const harbor = SEED_PLAN.projects.find((p) => p.key === "harbor");
		expect(harbor).toBeDefined();
		const statuses = new Set(harbor?.tasks.map((t) => t.status));
		for (const s of TEMPLATE_STATUSES["mfw-default"])
			expect(statuses.has(s)).toBe(true);
		expect(
			harbor?.tasks.filter((t) => t.parent === "limits").length,
		).toBeGreaterThan(2);
		expect(harbor?.tasks.some((t) => (t.dependsOn ?? []).length > 0)).toBe(
			true,
		);
		expect(
			harbor?.runs.some(
				(r) => r.end === "live" && r.activity === "needs_answer",
			),
		).toBe(true);
		expect(harbor?.groups?.length).toBe(1);
		expect(SEED_PLAN.projects.map((p) => p.template).sort()).toEqual([
			"kanban",
			"mfw-default",
			"planning",
		]);
	});

	test("the validator names what is wrong", () => {
		const bad: SeedPlan = {
			usage: { subscriptions: [] },
			projects: [
				{
					key: "p",
					name: "p",
					template: "kanban",
					repo: "x",
					tasks: [
						{ alias: "a", title: "A", status: "ready", created: "1d" },
						{
							alias: "b",
							title: "B",
							status: "todo",
							parent: "c",
							created: "bogus",
						},
					],
					runs: [
						{
							alias: "r",
							task: "ghost",
							harness: "claude-cli",
							model: "m",
							start: "1h",
							minutes: 1,
							end: "live",
							costUsd: 0,
							tokensIn: 0,
							tokensOut: 0,
						},
					],
				},
			],
		};
		const problems = validateSeedPlan(bad).join("\n");
		expect(problems).toMatch(/'ready' is not in kanban/);
		expect(problems).toMatch(/unknown reference 'c'/);
		expect(problems).toMatch(/bad age 'bogus'/);
		expect(problems).toMatch(/unknown task 'ghost'/);
		expect(problems).toMatch(/needs an activity/);
	});

	test("ages parse and reject nonsense", () => {
		expect(parseAgo("90m")).toBe(90);
		expect(parseAgo("2h30m")).toBe(150);
		expect(parseAgo("1d2h")).toBe(1560);
		expect(() => parseAgo("soon")).toThrow();
	});

	test("section paths resolve against seeded ids", () => {
		const ids = {
			projects: { harbor: "harbor-api" },
			tasks: { harbor: { admin: "HARBORAPI-5" } },
			runs: { headersRun: "01RUN" },
			groups: {},
		};
		expect(placeholdersOf("/p/{p:harbor}/n/task:{t:harbor:admin}")).toEqual([
			["p", "harbor", undefined],
			["t", "harbor", "admin"],
		]);
		expect(resolvePath("/p/{p:harbor}/flow?node=run:{r:headersRun}", ids)).toBe(
			"/p/harbor-api/flow?node=run:01RUN",
		);
		expect(() => resolvePath("/p/{p:nope}", ids)).toThrow(/unresolved/);
	});
});
