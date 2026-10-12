/**
 * The route tree, as data. Routes register themselves from
 * `apps/start/src/routes/`; this module indexes each route's file, feature
 * component, backing procedures, and allowed search params. `href` below is
 * live code: it is what the app navigates with.
 */

import { type NodeRef, nodeRef, parseNodeRef } from "./lib/nodeRef";

/** Procedure paths on `AppRouter`, the only data a screen may use. Keep in step with `packages/api/src/root.ts`. */
export type ProcedurePath =
	| "tasks.list"
	| "tasks.get"
	| "tasks.graph"
	| "board.schema"
	| "runs.active"
	| "runs.pipsByTask"
	| "runs.list"
	| "runs.listAll"
	| "runs.get"
	| "runs.entries"
	| "runs.steps"
	| "review.bundle"
	| "review.comments.list"
	| "review.repairBrief"
	| "inbox.list"
	| "clarify.open"
	| "clarify.get"
	| "sessions.open"
	| "sessions.get"
	| "system.health"
	| "system.metrics"
	| "node.story"
	| "brain.intents"
	| "brain.states"
	| "brain.session"
	| "node.get"
	| "flow.tree"
	| "flow.at"
	| "flow.spans"
	| "flow.live"
	| "groups.get"
	| "holds.list"
	| "board.schema"
	| "system.projects"
	| "system.projectDirectory"
	| "system.digest"
	| "system.scheduler.status"
	| "stats.outcomes"
	| "fleet.summary"
	| "events.list"
	| "adrs.list"
	| "adrs.get"
	| "docs.sources"
	| "docs.entries"
	| "docs.read"
	| "docs.search"
	| "docs.recent"
	| "docs.suggestions"
	| "files.worktrees"
	| "files.listDir"
	| "files.readFile"
	| "files.gitStatus"
	| "repo.summary"
	| "repo.refs"
	| "repo.branches"
	| "repo.worktrees"
	| "repo.commits"
	| "repo.commit"
	| "repo.diffFile"
	| "repo.compare"
	| "repo.tree"
	| "repo.blob"
	| "repo.worktreeChanges"
	| "repo.worktreeDiffFile"
	| "settings.get"
	| "boardConfig.get"
	| "boardConfig.templates"
	| "settings.providers.list"
	| "settings.providers.catalogue"
	| "resources.list"
	| "resources.get"
	| "budgets.list"
	| "hostResources.read"
	| "hostResources.audit"
	| "runpod.get"
	| "runpod.refresh"
	| "runpod.updatePolicy"
	| "runpod.updateSafety"
	| "runpod.setPaused"
	| "runpod.cleanup"
	| "openrouter.get"
	| "openrouter.refresh"
	| "triggers.list"
	| "triggers.deliveries"
	| "triggers.dryRun"
	| "live.events"
	| "live.runOutput";

/**
 * The URL state every lens and the inspector share (design §12.3):
 * `node` the selected node ref, `t` a past instant (absent = live), `f` a
 * filter expression, `w` the time window, `tab` the inspector tab.
 */
export interface NodeSearch {
	node?: NodeRef;
	t?: string;
	f?: string;
	w?: string;
	tab?: string;
}

/** Names `validateSearch` owns on the lens and inspector routes; listed in `RouteSpec.search`. */
export const NODE_SEARCH_KEYS = ["node", "t", "f", "w", "tab"] as const;

const WINDOW = /^(all|\d{1,3}[mhdw])$/;
const TAB = /^[a-z][a-z0-9-]{0,31}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
const CONTROL = /[\u0000-\u001f\u007f]/;

function nonEmpty(v: unknown, max = 200): string | undefined {
	return typeof v === "string" &&
		v.length > 0 &&
		v.length <= max &&
		!CONTROL.test(v)
		? v
		: undefined;
}

/**
 * Parse the shared search params. Invalid values are dropped (not thrown):
 * a hand-edited or stale link degrades to "nothing selected, live", never to
 * an error page. Only well-formed refs and instants survive.
 */
export function parseNodeSearch(search: Record<string, unknown>): NodeSearch {
	const out: NodeSearch = {};
	const node = nonEmpty(search.node, 600);
	if (node && parseNodeRef(node)) out.node = node;
	const t = nonEmpty(search.t, 40);
	if (t && Number.isFinite(Date.parse(t))) out.t = t;
	const f = nonEmpty(search.f);
	if (f) out.f = f;
	const w = nonEmpty(search.w, 8);
	if (w && WINDOW.test(w)) out.w = w;
	const tab = nonEmpty(search.tab, 32);
	if (tab && TAB.test(tab)) out.tab = tab;
	return out;
}

/** A ref or branch name as path segments: `/` stays, everything else is encoded. */
function refPath(name: string): string {
	return name.split("/").map(encodeURIComponent).join("/");
}

/** Drop `undefined` and empty keys so equal states produce equal URLs. */
function queryString(params: Record<string, string | undefined>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === "") continue;
		// `:` and `/` are legal in a query and make refs and instants readable and copyable.
		parts.push(
			`${key}=${encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/")}`,
		);
	}
	return parts.length ? `?${parts.join("&")}` : "";
}

export interface RouteSpec {
	/** URL path, TanStack Router syntax. */
	readonly path: string;
	/** File to create under `apps/start/src/routes/` (flat route convention). */
	readonly file: string;
	/** Feature component the route file composes; thin route, fat feature. */
	readonly component: string;
	/**
	 * Loaded via `queryClient.ensureQueryData` in the route loader (primary) or
	 * in-component (secondary). Listed primary-first.
	 */
	readonly queries: readonly ProcedurePath[];
	/** Validated with zod in `validateSearch`. Everything else must be a path. */
	readonly search?: readonly string[];
	/** Subscriptions this route owns, beyond the shell's app-wide one. */
	readonly subscriptions?: readonly ProcedurePath[];
	readonly notes?: string;
}

export const ROUTES = {
	root: {
		path: "/",
		file: "routes/__root.tsx",
		component: "components/AppShell",
		queries: [
			"system.projects",
			"system.projectDirectory",
			"inbox.list",
			"system.health",
			"runs.active",
			"clarify.open",
			"brain.states",
		],
		subscriptions: ["live.events", "live.runOutput"],
		notes:
			"Owns the ONE app-wide subscription (useLiveChannel), the tRPC " +
			"client + QueryClient, the toast viewport and the theme attributes. " +
			"Also mounts features/presence/PresenceBar on every screen: it reads " +
			"runs.active + inbox.list only (no per-run request, no transcript " +
			"stream).",
	},
	index: {
		path: "/",
		file: "routes/index.tsx",
		component: "features/home/HomePage",
		queries: [
			"inbox.list",
			"runs.active",
			"clarify.open",
			"sessions.open",
			"system.digest",
			"system.projects",
			"flow.live",
		],
		notes:
			"Home: the needs-you queue (inbox.list whole, so the count is the shell " +
			"badge; questions answered inline via clarify.open, approvals via a " +
			"run console, escalations via sessions.open), the live runs as the " +
			"same tree rows the Flow lens draws (flow.live per project with " +
			'live runs), and "Since you left" (system.digest ' +
			"against the lib/seen.ts marker, advanced only by Mark caught up).",
	},
	fleet: {
		path: "/fleet",
		file: "routes/fleet.index.tsx",
		component: "features/fleet/FleetPage",
		queries: ["fleet.summary", "stats.outcomes"],
		notes:
			"Fleet: where agents run and what they cost. One machine-wide read " +
			"(fleet.summary) of hosts, harness accounts, RunPod and OpenRouter, " +
			"with occupants as run chips (each opens its inspector in its own " +
			"project's Flow), budgets and ledger spend, holds with their reset " +
			"time, and health; plus first-pass outcomes per harness/model/tier " +
			"(stats.outcomes, the old Models table). Replaces /models, " +
			"/resources, /runpod and /openrouter.",
	},
	fleetResources: {
		path: "/fleet/resources",
		file: "routes/fleet.resources.tsx",
		component: "features/resources/ResourcesPage",
		queries: ["hostResources.read", "hostResources.audit"],
		notes:
			"Process-global host capacity, observations, waiters, leases, recovery, and audit. Never resolves a project service.",
	},
	fleetRunpod: {
		path: "/fleet/runpod",
		file: "routes/fleet.runpod.tsx",
		component: "features/runpod/RunPodGlobalPage",
		queries: [
			"runpod.get",
			"runpod.refresh",
			"runpod.setPaused",
			"runpod.cleanup",
		],
		notes:
			"Operations-only RunPod inventory, spend, pause, reconciliation, ownership-safe cleanup, and health. Never resolves a project service or renders settings forms.",
	},
	fleetOpenrouter: {
		path: "/fleet/openrouter",
		file: "routes/fleet.openrouter.tsx",
		component: "features/openrouter/OpenRouterGlobalPage",
		queries: ["openrouter.get", "openrouter.refresh"],
		notes:
			"Machine-wide OpenRouter usage, credits, provider/model activity, and live account health. Credentials remain in Settings.",
	},
	legacyFleet: {
		path: "/$",
		file: "routes/$.tsx",
		component: "redirect → fleet",
		queries: [],
		notes:
			"/models, /resources, /runpod and /openrouter (and their sub-paths) " +
			"redirect to the Fleet pages that replaced them (`legacyFleetPath`). " +
			"Any other unmatched path is a not-found.",
	},
	settings: {
		path: "/settings",
		file: "routes/settings.tsx",
		component: "features/settings/SettingsPage",
		queries: [
			"settings.providers.catalogue",
			"settings.providers.list",
			"runpod.get",
			"runpod.updateSafety",
			"openrouter.get",
		],
		search: ["tab"],
		notes:
			"Machine provider credentials, RunPod global safety, OpenRouter credentials, and browser appearance. Project " +
			"attachment lives in the sidebar; per-project settings live at " +
			"/p/$project/settings.",
	},
	project: {
		path: "/p/$project",
		file: "routes/p.$project.tsx",
		component: "features/shell/ProjectLayout",
		queries: ["tasks.list", "inbox.list"],
		notes:
			"Header + sub-nav. Every badge shares its query with the tab it sits " +
			"on: review/blocked from tasks.list, inbox from inbox.list.",
	},
	projectIndex: {
		path: "/p/$project/",
		file: "routes/p.$project.index.tsx",
		component: "redirect → board",
		queries: [],
	},
	board: {
		path: "/p/$project/board",
		file: "routes/p.$project.board.tsx",
		component: "features/board/BoardPage",
		queries: [
			"tasks.list",
			"board.schema",
			"runs.active",
			"clarify.open",
			"runs.pipsByTask",
			"brain.intents",
			"flow.at",
		],
		search: ["q", "label", "priority", "type", "gate", ...NODE_SEARCH_KEYS],
		notes:
			"Columns come from board.schema (the board's own statuses; terminal " +
			"ones collapsed). Cards read runs.active, clarify.open and " +
			"runs.pipsByTask once per board, never per card. " +
			"Drag → tasks.move, optimistic; rollback surfaces the server reason. " +
			"`?node=` opens the docked inspector (features/inspector) over the board.",
	},
	flow: {
		path: "/p/$project/flow",
		file: "routes/p.$project.flow.tsx",
		component: "features/flow/FlowPage",
		queries: ["flow.tree", "flow.spans"],
		search: [...NODE_SEARCH_KEYS],
		notes:
			"The work tree beside a shared time axis. flow.tree is the structure " +
			"(kept current by lib/live.ts patches), flow.spans the bars and " +
			"markers for the window (the query range snaps to a bucket so LIVE " +
			"does not refetch as the clock moves). `f` filter, `w` window, `t` " +
			"the window's right edge and the scrub cursor (absent = LIVE; set, " +
			"the tree is flow.at and the view is read-only), `node`/`tab` the " +
			"docked inspector.",
	},
	node: {
		path: "/p/$project/n/$ref",
		file: "routes/p.$project.n.$ref.tsx",
		component: "features/inspector/Inspector",
		queries: [
			"tasks.get",
			"tasks.list",
			"runs.get",
			"node.get",
			"flow.tree",
			"groups.get",
			"holds.list",
		],
		search: ["tab", "entry", "t"],
		notes:
			"The inspector as a full page: the same component as the dock, for any " +
			"node ref (`href.node`). `$ref` is a node ref (lib/nodeRef); an invalid " +
			"one renders a not-found state, not an error.",
	},
	docs: {
		path: "/p/$project/docs/$",
		file: "routes/p.$project.docs.$.tsx",
		component: "features/docs/DocsPage",
		queries: [
			"docs.sources",
			"docs.entries",
			"docs.read",
			"docs.search",
			"docs.recent",
			"docs.suggestions",
			"adrs.get",
		],
		search: ["q"],
		notes:
			"The project's documentation: board-fed document types and configured " +
			"directories. The splat is `<source>/<key>`: a board type name and a " +
			"document id (`adr/MFW-ADR-7`), or a directory source id and a path " +
			"inside it (`docs/guide/setup.md`). `q` is the search text. Directory " +
			"documents are read-only; an ADR keeps its edit form (adrs.update, " +
			"baseHash) in the reader.",
	},
	adrs: {
		path: "/p/$project/adrs",
		file: "routes/p.$project.adrs.tsx",
		component: "redirect → docs",
		queries: [],
		search: ["adr"],
		notes:
			"The ADRs tab became Docs. `?adr=<id>` goes to /docs/adr/<id>; this " +
			"path survives so old links keep working.",
	},
	task: {
		path: "/p/$project/tasks/$taskId",
		file: "routes/p.$project.tasks.$taskId.tsx",
		component:
			"features/tasks/TaskRoutePage (redirects to board ?node=task:<id> when the inspector can dock, else the inspector as a page)",
		queries: ["tasks.get", "node.story", "board.schema", "tasks.list"],
		notes:
			"tasks.update takes baseRev; a CONFLICT response or a live task.edited " +
			"event while dirty raises the conflict bar. The canonical, " +
			"shareable task URL (MFW-26).",
	},
	reviewTask: {
		path: "/p/$project/review/$taskId",
		file: "routes/p.$project.review.$taskId.tsx",
		component: "redirect → board ?node=task:<id>&tab=changes",
		queries: [],
		notes:
			"Review is the task inspector's Changes tab (features/review/ReviewPage " +
			"mounted by features/inspector). This path survives only so old links " +
			"and notifications keep working.",
	},
	repo: {
		path: "/p/$project/repo/$",
		file: "routes/p.$project.repo.$.tsx",
		component: "features/repo/RepoPage",
		queries: [
			"repo.summary",
			"repo.refs",
			"repo.branches",
			"repo.worktrees",
			"repo.commits",
			"repo.commit",
			"repo.diffFile",
			"repo.compare",
			"repo.tree",
			"repo.blob",
			"repo.worktreeChanges",
			"repo.worktreeDiffFile",
		],
		search: ["ref", "run", "path", "file", "q", "kind", "mode", "f"],
		notes:
			"The repository view, one splat route: `/repo/files`, `/repo/branches`, " +
			"`/repo/branches/<name>` (names keep their slashes), `/repo/worktrees`, " +
			"`/repo/worktree/<id>`, `/repo/commits`, `/repo/commit/<sha>`, " +
			"`/repo/compare/<a>...<b>`. Read only; the parse and the builders are " +
			"`features/repo/repoModel.ts` and `href.repo*`. Refs are validated and " +
			"resolved to shas in the daemon (`repo-view.ts`).",
	},
	files: {
		path: "/p/$project/files",
		file: "routes/p.$project.files.tsx",
		component: "redirect → /p/$project/repo/files (same search)",
		queries: [
			"files.listDir",
			"files.worktrees",
			"files.gitStatus",
			"files.readFile",
		],
		search: ["run", "path", "file"],
		notes:
			"Read-only. `run` picks the base (project root when absent); `path` is " +
			"the open directory and `file` the open file, both base-relative. " +
			"Containment lives in the daemon: FORBIDDEN means the path left the " +
			"tree, NOT_FOUND means it is not there, and the two never merge.",
	},
	projectSettings: {
		path: "/p/$project/settings",
		file: "routes/p.$project.settings.tsx",
		component: "features/settings/ProjectSettingsPage",
		queries: [
			"settings.get",
			"resources.list",
			"budgets.list",
			"boardConfig.get",
			"boardConfig.templates",
		],
		notes:
			"Per-project scope lives on the project, not in /settings. The project " +
			"comes from the route param, so there is no picker to disagree with it.",
	},
	triggers: {
		path: "/p/$project/triggers",
		file: "routes/p.$project.triggers.tsx",
		component: "features/triggers/TriggersPage",
		queries: ["triggers.list"],
		search: ["highlight"],
		notes:
			"MFW-117 phase 3. `highlight` names a defId (from an inbox row) so " +
			"the row it points at is scrolled to and outlined rather than making " +
			"the inbox item link to a screen that cannot show which trigger it " +
			"meant. Deliveries load per-row, on demand, via triggers.deliveries.",
	},
	run: {
		path: "/p/$project/runs/$runId",
		file: "routes/p.$project.runs.$runId.tsx",
		component: "features/transcript/RunPage",
		queries: ["runs.get", "runs.entries", "runs.steps"],
		search: ["entry", "q"],
		subscriptions: ["live.runOutput"],
		notes:
			"runs.entries is offset-addressed and live.runOutput yields byte " +
			"deltas past that offset; never re-fetch the whole log.",
	},
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/**
 * Where the pre-Fleet machine pages went. `/models` is the Fleet page itself
 * (its outcomes table is a section there); the rest are Fleet sub-routes.
 * Null for any path that was never one of them.
 */
export function legacyFleetPath(pathname: string): string | null {
	const first = pathname.split("/").filter(Boolean)[0];
	switch (first) {
		case "models":
			return "/fleet";
		case "resources":
			return "/fleet/resources";
		case "runpod":
			return "/fleet/runpod";
		case "openrouter":
			return "/fleet/openrouter";
		default:
			return null;
	}
}

/** Must stay empty: `"/"` would double every link (`//now`), and `//p/...` is protocol-relative. */
export const APP_ROOT = "";

/** Link targets: plain in-app paths. `withBase` adds the mount prefix for `<a href>`; `useGo()` (lib/nav) does client-side navigation. */
export const href = {
	/** The landing screen: Home (features/home). */
	home: () => `${APP_ROOT}/`,
	/** Fleet: hosts, harness accounts, providers, budgets (features/fleet). */
	fleet: () => `${APP_ROOT}/fleet`,
	/** Host resource control plane, a Fleet sub-route. */
	resources: () => `${APP_ROOT}/fleet/resources`,
	runpod: () => `${APP_ROOT}/fleet/runpod`,
	openrouter: () => `${APP_ROOT}/fleet/openrouter`,
	settings: () => `${APP_ROOT}/settings`,
	project: (project: string) => `${APP_ROOT}/p/${encodeURIComponent(project)}`,
	board: (project: string, at?: NodeSearch) =>
		`${href.project(project)}/board${queryString({ ...at })}`,
	/** The Flow lens: the work tree with a time axis. */
	flow: (project: string, at?: NodeSearch) =>
		`${href.project(project)}/flow${queryString({ ...at })}`,
	/** A node as a full page: `/p/mfw/n/run:01J…?tab=transcript`. */
	node: (
		project: string,
		ref: NodeRef,
		at?: { tab?: string; t?: string; entry?: number },
	) =>
		`${href.project(project)}/n/${encodeURIComponent(ref).replace(/%3A/gi, ":")}${queryString(
			{
				tab: at?.tab,
				t: at?.t,
				entry: at?.entry === undefined ? undefined : String(at.entry),
			},
		)}`,
	/**
	 * The Docs page. `source` is a board type name or a directory source id and
	 * `key` a document id or a path inside the source (kept as real `/`
	 * segments, so `docs/guide/setup.md` stays readable and relative links
	 * resolve the way a person expects).
	 */
	docs: (
		project: string,
		at?: { source?: string; key?: string; q?: string },
	) => {
		const path = at?.source
			? `/${encodeURIComponent(at.source)}${
					at.key
						? `/${at.key
								.split("/")
								.filter((s) => s.length > 0)
								.map(encodeURIComponent)
								.join("/")}`
						: ""
				}`
			: "";
		return `${href.project(project)}/docs${path}${queryString({ q: at?.q })}`;
	},
	/** One ADR in the Docs reader: `/p/mfw/docs/adr/MFW-ADR-7`. */
	adr: (project: string, adrId: string) =>
		href.docs(project, { source: "adr", key: adrId }),
	task: (project: string, taskId: string) =>
		`${href.project(project)}/tasks/${encodeURIComponent(taskId)}`,
	/** A task's diff and verdict: the inspector's Changes tab over the board. */
	changes: (project: string, taskId: string) =>
		href.board(project, { node: nodeRef.task(taskId), tab: "changes" }),
	/**
	 * Same target as `changes`. Kept under its old name because
	 * `features/tasks/TaskPage.tsx` still calls it; move that call site to
	 * `changes` and delete this when that page is next edited.
	 */
	reviewTask: (project: string, taskId: string) =>
		href.changes(project, taskId),
	/** Workspace browser. State is all in the URL (`run` or `ref`, `path`, `file`), so listings are linkable. `ref` browses a branch, tag or commit tree instead of a checkout. */
	files: (
		project: string,
		at?: { run?: string; ref?: string; path?: string; file?: string },
	) => {
		const query = new URLSearchParams();
		if (at?.ref) query.set("ref", at.ref);
		if (at?.run) query.set("run", at.run);
		if (at?.path) query.set("path", at.path);
		if (at?.file) query.set("file", at.file);
		const search = query.toString();
		return `${href.project(project)}/repo/files${search ? `?${search}` : ""}`;
	},
	/** The repository view's front page (the file browser). */
	repo: (project: string) => `${href.project(project)}/repo`,
	repoBranches: (project: string, at?: { q?: string; kind?: string }) =>
		`${href.project(project)}/repo/branches${queryString({ ...at })}`,
	/** One branch's page. Slashes in the name stay slashes. */
	repoBranch: (project: string, name: string) =>
		`${href.project(project)}/repo/branches/${refPath(name)}`,
	repoWorktrees: (project: string) => `${href.project(project)}/repo/worktrees`,
	repoWorktree: (project: string, id: string, at?: { f?: string }) =>
		`${href.project(project)}/repo/worktree/${encodeURIComponent(id)}${queryString({ ...at })}`,
	repoCommits: (
		project: string,
		at?: { ref?: string; path?: string; q?: string },
	) => `${href.project(project)}/repo/commits${queryString({ ...at })}`,
	repoCommit: (project: string, sha: string, at?: { f?: string }) =>
		`${href.project(project)}/repo/commit/${encodeURIComponent(sha)}${queryString({ ...at })}`,
	/** `a...b`, like a pull request: what `b` brought since it left `a`. */
	repoCompare: (
		project: string,
		a?: string,
		b?: string,
		at?: { mode?: "two-dot"; f?: string },
	) =>
		`${href.project(project)}/repo/compare${
			a && b ? `/${refPath(a)}...${refPath(b)}` : ""
		}${queryString({ ...at })}`,
	/** A run's full transcript page. The `/runs/` segment predates the Agents tab's removal and keeps old links valid. */
	run: (project: string, runId: string) =>
		`${href.project(project)}/runs/${encodeURIComponent(runId)}`,
	projectSettings: (project: string) => `${href.project(project)}/settings`,
	/** `highlight`: a defId to scroll to and outline, from an inbox row. */
	triggers: (project: string, highlight?: string) =>
		`${href.project(project)}/triggers${highlight ? `?highlight=${encodeURIComponent(highlight)}` : ""}`,
} as const;

/** The build-time mount, no trailing slash. `import.meta.env` is Vite's; it is absent under `bun test`, where the mount is the root. */
function mountPrefix(): string {
	return (import.meta.env?.BASE_URL ?? "/").replace(/\/+$/, "");
}

/** Prefix a route path with the build-time mount (`/mfw/`); the trailing slash of BASE_URL is trimmed. */
export function withBase(path: string): string {
	const prefix = mountPrefix();
	return `${prefix}${path}`;
}

/** Does `pathname` (with or without the mount prefix) sit under `path`? */
export function isActive(pathname: string, path: string): boolean {
	const prefix = mountPrefix();
	const stripped = pathname.startsWith(prefix)
		? pathname.slice(prefix.length) || "/"
		: pathname;
	return stripped === path || stripped.startsWith(`${path}/`);
}
