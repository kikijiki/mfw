import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRouter } from "@mfw/api";
import { formatFlowFilter, parseFlowFilter } from "./features/flow/flowModel";
import {
	href,
	legacyFleetPath,
	NODE_SEARCH_KEYS,
	parseNodeSearch,
	ROUTES,
} from "./routes";

/**
 * The route table names the procedures each screen reads. A rename on the API
 * (or a typo here) would otherwise leave the table describing data nobody
 * serves.
 */
describe("procedure list", () => {
	const procedures = new Set(
		Object.keys(
			(appRouter as unknown as { _def: { procedures: object } })._def
				.procedures,
		),
	);

	test("every query and subscription a route lists exists on AppRouter", () => {
		const missing = Object.entries(ROUTES).flatMap(([name, spec]) =>
			[...spec.queries, ...("subscriptions" in spec ? spec.subscriptions : [])]
				.filter((p) => !procedures.has(p))
				.map((p) => `${name}: ${p}`),
		);
		expect(missing).toEqual([]);
	});

	test("Home is registered on the procedures it needs", () => {
		// The needs list is inbox.list whole; escalation briefs are started and
		// resolved on Home; "Since you left" is the digest.
		expect(ROUTES.index.queries).toContain("inbox.list");
		expect(ROUTES.index.queries).toContain("sessions.open");
		expect(ROUTES.index.queries).toContain("system.digest");
	});

	test("the Agents surfaces are gone: no route, no link helper", () => {
		expect("agents" in ROUTES).toBe(false);
		expect("runs" in ROUTES).toBe(false);
		expect("agents" in href).toBe(false);
		expect("runs" in href).toBe(false);
	});
});

/**
 * Link shape. A leading `//` is a protocol-relative URL, so `//p/mfw/board`
 * would send the browser looking for a host called `p`.
 */
describe("href", () => {
	const all = [
		href.home(),
		href.fleet(),
		href.resources(),
		href.runpod(),
		href.openrouter(),
		href.settings(),
		href.project("mfw"),
		href.board("mfw"),
		href.docs("mfw"),
		href.adr("mfw", "MFW-ADR-2"),
		href.changes("mfw", "MFW-70"),
		href.task("mfw", "MFW-1"),
		href.files("mfw"),
		href.run("mfw", "01JQ2"),
	];

	test("every link is a single-slash absolute path", () => {
		for (const path of all) {
			expect(path.startsWith("/")).toBe(true);
			expect(path.startsWith("//")).toBe(false);
			expect(path).not.toContain("//");
		}
	});

	test("paths match the routes the router registers", () => {
		expect(href.home()).toBe("/");
		expect(href.fleet()).toBe("/fleet");
		expect(href.resources()).toBe("/fleet/resources");
		expect(href.runpod()).toBe("/fleet/runpod");
		expect(href.openrouter()).toBe("/fleet/openrouter");
		expect(href.board("mfw")).toBe("/p/mfw/board");
		expect(href.docs("mfw")).toBe("/p/mfw/docs");
		expect(href.adr("mfw", "MFW-ADR-2")).toBe("/p/mfw/docs/adr/MFW-ADR-2");
		expect(href.docs("mfw", { source: "docs", key: "guide/set up.md" })).toBe(
			"/p/mfw/docs/docs/guide/set%20up.md",
		);
		expect(href.docs("mfw", { q: "wal mode" })).toBe(
			"/p/mfw/docs?q=wal%20mode",
		);
		expect(href.task("mfw", "MFW-1")).toBe("/p/mfw/tasks/MFW-1");
		// A run's page keeps the `/runs/` segment so old links stay valid.
		expect(href.run("mfw", "01JQ2")).toBe("/p/mfw/runs/01JQ2");
	});

	test("project names and task ids are encoded, not interpolated raw", () => {
		expect(href.project("a b")).toBe("/p/a%20b");
		expect(href.task("p", "A/B")).toBe("/p/p/tasks/A%2FB");
		expect(href.adr("p", "A/B")).toBe("/p/p/docs/adr/A/B");
		expect(href.docs("a b", { source: "x y" })).toBe("/p/a%20b/docs/x%20y");
	});

	test("review is the inspector's Changes tab over the board", () => {
		expect(href.changes("mfw", "MFW-70")).toBe(
			"/p/mfw/board?node=task:MFW-70&tab=changes",
		);
		// The old helper name resolves to the same place.
		expect(href.reviewTask("mfw", "MFW-70")).toBe(
			href.changes("mfw", "MFW-70"),
		);
		// There is no review list route any more; the old per-task path redirects.
		expect("review" in ROUTES).toBe(false);
		expect("review" in href).toBe(false);
		expect(ROUTES.reviewTask.component).toContain("redirect");
	});

	test("the old /review/:taskId path redirects to the Changes tab", async () => {
		const { Route } = await import("./routes/p.$project.review.$taskId");
		const beforeLoad = (
			Route as unknown as {
				options: { beforeLoad: (ctx: { params: unknown }) => void };
			}
		).options.beforeLoad;
		let thrown: unknown;
		try {
			beforeLoad({ params: { project: "mfw", taskId: "MFW-70" } });
		} catch (error) {
			thrown = error;
		}
		const options = (thrown as { options?: { to?: string } } | undefined)
			?.options;
		expect(options?.to).toBe("/p/mfw/board?node=task:MFW-70&tab=changes");
	});

	test("the old /files path redirects into the repo view, keeping its search", async () => {
		const { Route } = await import("./routes/p.$project.files");
		const beforeLoad = (
			Route as unknown as {
				options: {
					beforeLoad: (ctx: { params: unknown; search: unknown }) => void;
				};
			}
		).options.beforeLoad;
		let thrown: unknown;
		try {
			beforeLoad({
				params: { project: "mfw" },
				search: { run: "01J", path: "src" },
			});
		} catch (error) {
			thrown = error;
		}
		const options = (thrown as { options?: { to?: string } } | undefined)
			?.options;
		expect(options?.to).toBe("/p/mfw/repo/files?run=01J&path=src");
	});
});

describe("the ADRs tab became Docs", () => {
	const redirectOf = async (search: { adr?: string }) => {
		const { Route } = await import("./routes/p.$project.adrs");
		const beforeLoad = (
			Route as unknown as {
				options: {
					beforeLoad: (ctx: { params: unknown; search: unknown }) => void;
				};
			}
		).options.beforeLoad;
		let thrown: unknown;
		try {
			beforeLoad({ params: { project: "mfw" }, search });
		} catch (error) {
			thrown = error;
		}
		return (thrown as { options?: { to?: string } } | undefined)?.options?.to;
	};

	test("/adrs?adr=ID opens that ADR in the Docs reader", async () => {
		expect(await redirectOf({ adr: "MFW-ADR-7" })).toBe(
			"/p/mfw/docs/adr/MFW-ADR-7",
		);
	});

	test("a bare /adrs lands on the ADR source", async () => {
		expect(await redirectOf({})).toBe("/p/mfw/docs/adr");
	});

	test("the route table names the Docs page and its procedures", () => {
		expect(ROUTES.docs.path).toBe("/p/$project/docs/$");
		expect(ROUTES.docs.component).toBe("features/docs/DocsPage");
		expect(ROUTES.docs.queries).toContain("docs.search");
		expect(ROUTES.adrs.component).toContain("redirect");
		expect("adrs" in href).toBe(false);
	});
});

describe("node links and search params", () => {
	test("href.home, href.flow and href.node are single-slash paths", () => {
		expect(href.home()).toBe("/");
		expect(href.flow("mfw")).toBe("/p/mfw/flow");
		expect(href.node("mfw", "run:01JQ2")).toBe("/p/mfw/n/run:01JQ2");
		for (const p of [
			href.home(),
			href.flow("a b", { node: "task:X-1", t: "2026-10-12T10:41:00Z" }),
			href.node("a b", "sub:r/c", { tab: "transcript", entry: 812 }),
			href.board("mfw", { node: "task:MFW-1" }),
		]) {
			expect(p.startsWith("/")).toBe(true);
			expect(p.startsWith("//")).toBe(false);
		}
	});

	test("params build the documented deep links", () => {
		expect(
			href.flow("mfw", {
				node: "run:01JQ2",
				t: "2026-10-12T10:41:00Z",
				f: "needs:me",
			}),
		).toBe("/p/mfw/flow?node=run:01JQ2&t=2026-10-12T10:41:00Z&f=needs:me");
		expect(
			href.node("mfw", "run:01JQ2", { tab: "transcript", entry: 812 }),
		).toBe("/p/mfw/n/run:01JQ2?tab=transcript&entry=812");
		expect(href.node("mfw", "decision:512")).toBe("/p/mfw/n/decision:512");
		expect(href.board("mfw", { node: "task:MFW-41", tab: "story" })).toBe(
			"/p/mfw/board?node=task:MFW-41&tab=story",
		);
		// no params, no `?`
		expect(href.board("mfw", {})).toBe("/p/mfw/board");
	});

	test("a ref with a slash in an id is encoded in the path", () => {
		expect(href.node("p", "task:A/B")).toBe("/p/p/n/task:A%2FB");
	});

	test("validateSearch keeps valid values", () => {
		expect(
			parseNodeSearch({
				node: "task:MFW-41",
				t: "2026-10-12T10:41:00Z",
				f: "needs:me",
				w: "24h",
				tab: "story",
			}),
		).toEqual({
			node: "task:MFW-41",
			t: "2026-10-12T10:41:00Z",
			f: "needs:me",
			w: "24h",
			tab: "story",
		});
	});

	test("invalid refs, instants, windows and tabs are dropped, not thrown", () => {
		expect(
			parseNodeSearch({
				node: "nonsense",
				t: "yesterday",
				w: "forever",
				tab: "Not A Tab",
				f: "",
			}),
		).toEqual({});
		expect(parseNodeSearch({ node: 42, t: null, tab: ["a"] })).toEqual({});
		expect(parseNodeSearch({ node: "decision:abc" })).toEqual({});
		expect(parseNodeSearch({ node: "run:a\nb" })).toEqual({});
	});

	test("the lens routes list the shared params", () => {
		for (const key of NODE_SEARCH_KEYS) {
			expect(ROUTES.board.search).toContain(key);
		}
	});

	test("every route file in the table exists", () => {
		const missing = Object.entries(ROUTES)
			.map(([name, spec]) => [name, join(import.meta.dir, spec.file)] as const)
			.filter(([, file]) => !existsSync(file))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});
});

describe("the Flow route", () => {
	test("is registered: a file, the generated tree and the lens search params", () => {
		expect(existsSync(join(import.meta.dir, ROUTES.flow.file))).toBe(true);
		const tree = readFileSync(
			join(import.meta.dir, "routeTree.gen.ts"),
			"utf8",
		);
		expect(tree).toContain("'/p/$project/flow'");
		expect(tree).toContain("./routes/p.$project.flow");
		for (const key of NODE_SEARCH_KEYS) {
			expect(ROUTES.flow.search).toContain(key);
		}
		expect(ROUTES.flow.queries).toEqual(["flow.tree", "flow.spans"]);
	});

	test("filter, window, time and selection round-trip through the URL", () => {
		const filter = parseFlowFilter(
			"needs:me live status:in_progress host:ssh:box parse config",
		);
		const url = href.flow("mfw", {
			f: formatFlowFilter(filter),
			w: "8h",
			t: "2026-10-12T10:41:00.000Z",
			node: "run:01JQ2",
		});
		const query = Object.fromEntries(
			new URLSearchParams(url.slice(url.indexOf("?") + 1)),
		);
		const back = parseNodeSearch(query);
		expect(back).toEqual({
			f: "needs:me live status:in_progress host:ssh:box parse config",
			w: "8h",
			t: "2026-10-12T10:41:00.000Z",
			node: "run:01JQ2",
		});
		expect(parseFlowFilter(back.f)).toEqual(filter);
	});
});

describe("the Fleet routes", () => {
	const here = (p: string) => join(import.meta.dir, p);

	test("Fleet replaces Models, Resources, RunPod and OpenRouter as pages", () => {
		for (const name of ["models", "resources", "runpod", "openrouter"]) {
			expect(name in ROUTES).toBe(false);
		}
		expect("models" in href).toBe(false);
		for (const gone of [
			"routes/models.tsx",
			"routes/resources.tsx",
			"routes/runpod.tsx",
			"routes/openrouter.tsx",
			"features/models/ModelsPage.tsx",
		]) {
			expect(existsSync(here(gone))).toBe(false);
		}
		expect(ROUTES.fleet.path).toBe("/fleet");
		expect(ROUTES.fleet.queries).toContain("fleet.summary");
		expect(ROUTES.fleetRunpod.path).toBe("/fleet/runpod");
		expect(ROUTES.fleetOpenrouter.path).toBe("/fleet/openrouter");
		expect(ROUTES.fleetResources.path).toBe("/fleet/resources");
	});

	test("the generated tree registers the Fleet pages and no old page", () => {
		const tree = readFileSync(here("routeTree.gen.ts"), "utf8");
		for (const path of [
			"'/fleet/'",
			"'/fleet/runpod'",
			"'/fleet/openrouter'",
			"'/fleet/resources'",
		]) {
			expect(tree).toContain(path);
		}
		for (const old of ["/models", "/resources", "/runpod", "/openrouter"]) {
			expect(tree).not.toContain(`path: '${old}'`);
		}
	});

	test("the old machine pages redirect, anything else is not a redirect", () => {
		expect(legacyFleetPath("/models")).toBe("/fleet");
		expect(legacyFleetPath("/resources")).toBe("/fleet/resources");
		expect(legacyFleetPath("/runpod")).toBe("/fleet/runpod");
		expect(legacyFleetPath("/openrouter/")).toBe("/fleet/openrouter");
		expect(legacyFleetPath("/p/mfw/board")).toBeNull();
		expect(legacyFleetPath("/nowhere")).toBeNull();
		const splat = readFileSync(here("routes/$.tsx"), "utf8");
		expect(splat).toContain("legacyFleetPath(location.pathname)");
		expect(splat).toContain("redirect(");
	});
});
