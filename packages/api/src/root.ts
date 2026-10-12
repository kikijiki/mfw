import { adrsRouter } from "./router/adrs.ts";
import { boardRouter } from "./router/board.ts";
import { boardConfigRouter } from "./router/board-config.ts";
import { brainRouter } from "./router/brain.ts";
import { budgetsRouter } from "./router/budgets.ts";
import { clarifyRouter } from "./router/clarify.ts";
import { docsRouter } from "./router/docs.ts";
import { eventsRouter } from "./router/events.ts";
import { filesRouter } from "./router/files.ts";
import { fleetRouter } from "./router/fleet.ts";
import { flowRouter } from "./router/flow.ts";
import { groupsRouter } from "./router/groups.ts";
import { holdsRouter } from "./router/holds.ts";
import { hostResourcesRouter } from "./router/host-resources.ts";
import { hostsRouter } from "./router/hosts.ts";
import { inboxRouter } from "./router/inbox.ts";
import { liveRouter } from "./router/live.ts";
import { nodeRouter } from "./router/node.ts";
import { openrouterAccountRouter } from "./router/openrouter-account.ts";
import { projectsRouter } from "./router/projects.ts";
import { repoRouter } from "./router/repo.ts";
import { resourcesRouter } from "./router/resources.ts";
import { reviewRouter } from "./router/review.ts";
import { runpodAccountRouter } from "./router/runpod-account.ts";
import { runsRouter } from "./router/runs.ts";
import { sessionsRouter } from "./router/sessions.ts";
import { settingsRouter } from "./router/settings.ts";
import { statsRouter } from "./router/stats.ts";
import { systemRouter } from "./router/system.ts";
import { tasksRouter } from "./router/tasks.ts";
import { triggersRouter } from "./router/triggers.ts";
import { usageRouter } from "./router/usage.ts";
import { createCallerFactory, createTRPCRouter } from "./trpc.ts";

/**
 * The v2 API surface - a small resource model, not a mirror of daemon methods.
 * Routers receive only the services they need via `projectProcedure`.
 */
export const appRouter = createTRPCRouter({
	tasks: tasksRouter,
	adrs: adrsRouter,
	docs: docsRouter,
	board: boardRouter,
	boardConfig: boardConfigRouter,
	brain: brainRouter,
	budgets: budgetsRouter,
	node: nodeRouter,
	fleet: fleetRouter,
	flow: flowRouter,
	groups: groupsRouter,
	holds: holdsRouter,
	runs: runsRouter,
	review: reviewRouter,
	inbox: inboxRouter,
	system: systemRouter,
	projects: projectsRouter,
	live: liveRouter,
	hostResources: hostResourcesRouter,
	hosts: hostsRouter,
	events: eventsRouter,
	clarify: clarifyRouter,
	files: filesRouter,
	repo: repoRouter,
	resources: resourcesRouter,
	runpod: runpodAccountRouter,
	openrouter: openrouterAccountRouter,
	settings: settingsRouter,
	triggers: triggersRouter,
	sessions: sessionsRouter,
	stats: statsRouter,
	usage: usageRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
