/**
 * The route tree, as data. Routes register themselves from
 * `apps/start/src/routes/`; this module indexes each route's file, feature
 * component, backing procedures, and allowed search params. `href` below is
 * live code: it is what the app navigates with.
 */

/** Procedure paths on `AppRouter`, the only data a screen may use. Keep in step with `packages/api/src/root.ts`. */
export type ProcedurePath =
	| "tasks.list"
	| "tasks.get"
	| "tasks.graph"
	| "runs.active"
	| "runs.list"
	| "runs.get"
	| "runs.entries"
	| "runs.steps"
	| "review.bundle"
	| "review.comments.list"
	| "review.repairBrief"
	| "inbox.list"
	| "clarify.open"
	| "clarify.get"
	| "system.health"
	| "system.metrics"
	| "system.taskTrace"
	| "system.projects"
	| "system.projectDirectory"
	| "system.digest"
	| "system.scheduler.status"
	| "events.list"
	| "adrs.list"
	| "adrs.get"
	| "files.worktrees"
	| "files.listDir"
	| "files.readFile"
	| "files.gitStatus"
	| "settings.get"
	| "settings.providers.list"
	| "settings.providers.catalogue"
	| "resources.list"
	| "resources.get"
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
		],
		subscriptions: ["live.events"],
		notes:
			"Owns the ONE app-wide subscription (useLiveChannel), the tRPC " +
			"client + QueryClient, the toast viewport and the theme attributes.",
	},
	index: {
		path: "/",
		file: "routes/index.tsx",
		component: "redirect → /now",
		queries: [],
	},
	now: {
		path: "/now",
		file: "routes/now.tsx",
		component: "features/now/NowPage",
		queries: ["runs.active", "system.health"],
		search: ["run"],
		subscriptions: ["live.runOutput"],
		notes:
			"The selected run's transcript streams inline; live.runOutput is only " +
			"subscribed for runs that are not terminal.",
	},
	inbox: {
		path: "/inbox",
		file: "routes/inbox.tsx",
		component: "features/inbox/InboxPage",
		queries: ["inbox.list", "clarify.open", "clarify.get"],
		notes:
			"inbox.list is cross-project and server-computed; the badge, the " +
			"notifications and this list must never disagree. clarify.open is a " +
			"join on top of it (by runId, for the question text), never a second " +
			"source of rows; clarify.get backs the answer dialog.",
	},
	history: {
		path: "/history",
		file: "routes/history.tsx",
		component: "features/history/HistoryPage",
		queries: ["system.digest", "system.projects"],
		notes:
			"The since-marker is per-project localStorage, advanced only by the " +
			"explicit Caught up button.",
	},
	resources: {
		path: "/resources",
		file: "routes/resources.tsx",
		component: "features/resources/ResourcesPage",
		queries: ["hostResources.read", "hostResources.audit"],
		notes:
			"Process-global host capacity, observations, waiters, leases, recovery, and audit. Never resolves a project service.",
	},
	runpod: {
		path: "/runpod",
		file: "routes/runpod.tsx",
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
	openrouter: {
		path: "/openrouter",
		file: "routes/openrouter.tsx",
		component: "features/openrouter/OpenRouterGlobalPage",
		queries: ["openrouter.get", "openrouter.refresh"],
		notes:
			"Machine-wide OpenRouter usage, credits, provider/model activity, and live account health. Credentials remain in Settings.",
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
	projectInbox: {
		path: "/p/$project/inbox",
		file: "routes/p.$project.inbox.tsx",
		component: "features/inbox/InboxPage",
		queries: ["inbox.list", "clarify.open", "clarify.get"],
		notes:
			"The SAME component and the SAME cross-project inbox.list as /inbox, " +
			"narrowed to this project's rows for display (features/inbox/useInbox). " +
			"There is no project-scoped inbox procedure and there must not be: one " +
			"derivation means the badge, the notifications and both lists cannot " +
			"disagree.",
	},
	board: {
		path: "/p/$project/board",
		file: "routes/p.$project.board.tsx",
		component: "features/board/BoardPage",
		queries: ["tasks.list"],
		search: ["q", "label", "priority", "type"],
		notes:
			"Drag → tasks.move, optimistic; rollback surfaces the server reason.",
	},
	adrs: {
		path: "/p/$project/adrs",
		file: "routes/p.$project.adrs.tsx",
		component: "features/adrs/AdrsPage",
		queries: ["adrs.list", "tasks.list"],
		search: ["adr"],
		notes:
			"Architecture decision records. The selected ADR is in the URL; edits " +
			"to a proposed ADR use baseHash. Accepted ADRs are frozen and changed " +
			"only via adrs.supersede.",
	},
	task: {
		path: "/p/$project/tasks/$taskId",
		file: "routes/p.$project.tasks.$taskId.tsx",
		component: "features/tasks/TaskPage, inside features/tasks/TaskOverlay",
		queries: ["tasks.get", "system.taskTrace", "tasks.list"],
		notes:
			"tasks.update takes baseRev; a CONFLICT response or a live task.edited " +
			"event while dirty raises the conflict bar. The canonical, " +
			"shareable task URL (MFW-26); mounts its own backdrop BoardPage, since " +
			"whoever reached it this way has no board instance to inherit.",
	},
	boardTaskOverlay: {
		path: "/p/$project/board/tasks/$taskId",
		file: "routes/p.$project.board.tasks.$taskId.tsx",
		component: "features/tasks/TaskOverlay",
		queries: ["tasks.get", "system.taskTrace", "tasks.list"],
		notes:
			"MFW-26: not a URL that ever shows; `routeMasks` (router.tsx) masks it " +
			"back to the flat `tasks.$taskId` path above. It exists only as a " +
			"child of `board`, so the already-mounted BoardPage stays behind the " +
			"panel instead of a second one appearing.",
	},
	review: {
		path: "/p/$project/review",
		file: "routes/p.$project.review.index.tsx",
		component: "features/review/ReviewQueueList",
		queries: ["tasks.list"],
	},
	reviewTask: {
		path: "/p/$project/review/$taskId",
		file: "routes/p.$project.review.$taskId.tsx",
		component: "features/review/ReviewPage",
		queries: [
			"review.bundle",
			"review.comments.list",
			"review.repairBrief",
			"inbox.list",
		],
		search: ["file", "from"],
	},
	files: {
		path: "/p/$project/files",
		file: "routes/p.$project.files.tsx",
		component: "features/files/FilesPage",
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
	runs: {
		path: "/p/$project/runs",
		file: "routes/p.$project.runs.index.tsx",
		component: "features/transcript/RunsListPage",
		queries: ["runs.list"],
	},
	projectSettings: {
		path: "/p/$project/settings",
		file: "routes/p.$project.settings.tsx",
		component: "features/settings/ProjectSettingsPage",
		queries: ["settings.get", "resources.list"],
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

/** Must stay empty: `"/"` would double every link (`//now`), and `//p/...` is protocol-relative. */
export const APP_ROOT = "";

/** Link targets: plain in-app paths. `withBase` adds the mount prefix for `<a href>`; `useGo()` (lib/nav) does client-side navigation. */
export const href = {
	now: () => `${APP_ROOT}/now`,
	inbox: () => `${APP_ROOT}/inbox`,
	history: () => `${APP_ROOT}/history`,
	resources: () => `${APP_ROOT}/resources`,
	runpod: () => `${APP_ROOT}/runpod`,
	openrouter: () => `${APP_ROOT}/openrouter`,
	settings: () => `${APP_ROOT}/settings`,
	project: (project: string) => `${APP_ROOT}/p/${encodeURIComponent(project)}`,
	board: (project: string) => `${href.project(project)}/board`,
	adrs: (project: string, adrId?: string) =>
		`${href.project(project)}/adrs${adrId ? `?adr=${encodeURIComponent(adrId)}` : ""}`,
	/** This project's slice of the one inbox; see ROUTES.projectInbox. */
	projectInbox: (project: string) => `${href.project(project)}/inbox`,
	task: (project: string, taskId: string) =>
		`${href.project(project)}/tasks/${encodeURIComponent(taskId)}`,
	review: (project: string) => `${href.project(project)}/review`,
	reviewTask: (
		project: string,
		taskId: string,
		from?: "inbox" | "project-inbox",
	) =>
		`${href.review(project)}/${encodeURIComponent(taskId)}${from ? `?from=${from}` : ""}`,
	/** Workspace browser. State is all in the URL (`run`, `path`, `file`), so listings are linkable. */
	files: (
		project: string,
		at?: { run?: string; path?: string; file?: string },
	) => {
		const query = new URLSearchParams();
		if (at?.run) query.set("run", at.run);
		if (at?.path) query.set("path", at.path);
		if (at?.file) query.set("file", at.file);
		const search = query.toString();
		return `${href.project(project)}/files${search ? `?${search}` : ""}`;
	},
	runs: (project: string) => `${href.project(project)}/runs`,
	run: (project: string, runId: string) =>
		`${href.runs(project)}/${encodeURIComponent(runId)}`,
	projectSettings: (project: string) => `${href.project(project)}/settings`,
	/** `highlight`: a defId to scroll to and outline, from an inbox row. */
	triggers: (project: string, highlight?: string) =>
		`${href.project(project)}/triggers${highlight ? `?highlight=${encodeURIComponent(highlight)}` : ""}`,
} as const;

/** Prefix a route path with the build-time mount (`/mfw/`); the trailing slash of BASE_URL is trimmed. */
export function withBase(path: string): string {
	const prefix = import.meta.env.BASE_URL.replace(/\/+$/, "");
	return `${prefix}${path}`;
}

/** Does `pathname` (with or without the mount prefix) sit under `path`? */
export function isActive(pathname: string, path: string): boolean {
	const prefix = import.meta.env.BASE_URL.replace(/\/+$/, "");
	const stripped = pathname.startsWith(prefix)
		? pathname.slice(prefix.length) || "/"
		: pathname;
	return stripped === path || stripped.startsWith(`${path}/`);
}
