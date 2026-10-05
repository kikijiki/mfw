import { adrsRouter } from "./router/adrs.ts";
import { clarifyRouter } from "./router/clarify.ts";
import { eventsRouter } from "./router/events.ts";
import { filesRouter } from "./router/files.ts";
import { hostResourcesRouter } from "./router/host-resources.ts";
import { inboxRouter } from "./router/inbox.ts";
import { liveRouter } from "./router/live.ts";
import { openrouterAccountRouter } from "./router/openrouter-account.ts";
import { resourcesRouter } from "./router/resources.ts";
import { reviewRouter } from "./router/review.ts";
import { runpodAccountRouter } from "./router/runpod-account.ts";
import { runsRouter } from "./router/runs.ts";
import { sessionsRouter } from "./router/sessions.ts";
import { settingsRouter } from "./router/settings.ts";
import { systemRouter } from "./router/system.ts";
import { tasksRouter } from "./router/tasks.ts";
import { triggersRouter } from "./router/triggers.ts";
import { createCallerFactory, createTRPCRouter } from "./trpc.ts";

/**
 * The v2 API surface - a small resource model, not a mirror of daemon methods.
 * Routers receive only the services they need via `projectProcedure`.
 */
export const appRouter = createTRPCRouter({
	tasks: tasksRouter,
	adrs: adrsRouter,
	runs: runsRouter,
	review: reviewRouter,
	inbox: inboxRouter,
	system: systemRouter,
	live: liveRouter,
	hostResources: hostResourcesRouter,
	events: eventsRouter,
	clarify: clarifyRouter,
	files: filesRouter,
	resources: resourcesRouter,
	runpod: runpodAccountRouter,
	openrouter: openrouterAccountRouter,
	settings: settingsRouter,
	triggers: triggersRouter,
	sessions: sessionsRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
