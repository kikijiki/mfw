import type { ProjectDbHandle } from "@mfw/db/client";
import type {
	EventBus,
	EventPage,
	EventQuery,
	StoredEvent,
} from "@mfw/db/eventlog";
import type { AdrService } from "./adrs.ts";
import type { AgentHost } from "./agent-host.ts";
import type { ProjectConfig } from "./boot.ts";
import type { BrainService } from "./brain.ts";
import type { ClarifyService } from "./clarify.ts";
import type { GlobalDispatch } from "./global-dispatch.ts";
import type { Health } from "./health.ts";
import type {
	HostResourceCoordinator,
	HostResourceCoordinatorPort,
} from "./host-resources/index.ts";
import type { InboxService } from "./inbox.ts";
import type { LifetimeManager } from "./lifetime.ts";
import type { Logger } from "./log.ts";
import type { Maintenance } from "./maintenance.ts";
import type { MergeQueue } from "./merge-queue.ts";
import type { OpenRouterAccountService } from "./openrouter-account-service.ts";
import type { ProjectDispatchAdmission } from "./project-dispatch-admission.ts";
import type { ResourceService } from "./resources.ts";
import type { ReviewService } from "./review.ts";
import type { RunEngine } from "./run-engine.ts";
import type { RunRegistry } from "./run-registry.ts";
import type { RunPodAccountService } from "./runpod-account-service.ts";
import type { Scheduler } from "./scheduler.ts";
import type { SessionService } from "./session.ts";
import type { ProviderSettings, SettingsService } from "./settings.ts";
import type { Supervisor } from "./supervisor.ts";
import type { TaskService } from "./task-service.ts";
import type { BoardRepo } from "./tasks/board-git.ts";
import type { TriggerService } from "./triggers/service.ts";
import type { WorkspaceService } from "./workspace.ts";

/**
 * The service bag for one attached project. Each router destructures the one
 * or two services it needs, and no service holds a reference to the bag.
 */
export interface ProjectServices {
	name: string;
	/** Stable identity; names and paths are display/location metadata only. */
	projectId: string;
	root: string;
	mfwDir: string;
	integrationBranch: string;
	/** Whether boot starts this project's dispatch loop (default false). */
	schedulerAutostart: boolean;
	handle: ProjectDbHandle;
	bus: EventBus;
	log: Logger;
	/** Narrow global admission/recovery port; never a ProjectServices backref. */
	hostResources: HostResourceCoordinatorPort;
	/** Detach removes only this wake subscription, never the project's leases. */
	releaseHostWake: () => void;
	tasks: TaskService;
	registry: RunRegistry;
	host: AgentHost;
	engine: RunEngine;
	/** Shared automatic/manual task admission and recovery owner. */
	admission: ProjectDispatchAdmission;
	mergeQueue: MergeQueue;
	supervisor: Supervisor;
	health: Health;
	scheduler: Scheduler;
	brain: BrainService;
	/** Versions the board on its own branch (no-op outside a git repo). */
	board: BoardRepo;
	/** Releases this project's single-daemon lock. Called by shutdown. */
	releaseLock: () => Promise<void>;
	inbox: InboxService;
	review: ReviewService;
	maintenance: Maintenance;
	/** MFW-59: pre-loaded brain sessions, raised when recovery is exhausted and
	 *  opened only when a human asks. */
	sessions: SessionService;
	lifetime: LifetimeManager;
	/** Project triggers: definitions in the repo, arming in the daemon home. */
	triggers: TriggerService;
	/** Architecture decision records (`.mfw/adrs`). */
	adrs: AdrService;
	/** Planner/importer questions and the answers that re-plan against them. */
	clarify: ClarifyService;
	/** Read-only, containment-checked browser over the repo and worktrees. */
	workspace: WorkspaceService;
	/** Resource definitions + the slot semaphore's admin surface. */
	resources: ResourceService;
	/** Persisted per-project operating config. */
	settings: SettingsService;
	/** Read side of the audit stream, so the API never touches the DB. */
	events: EventStore;
}

/** The audit-stream reads the API needs (the write side is transactional and
 *  belongs to the services that change state). */
export interface EventStore {
	since(seq: number, limit?: number): Promise<StoredEvent[]>;
	latestSeq(): Promise<number>;
	/** Paged, filterable audit feed for the HISTORY timeline. */
	list(query: EventQuery): Promise<EventPage>;
}

export type { EventPage, EventQuery, StoredEvent };

export interface DetachResult {
	name: string;
	root: string;
	/** Whether an entry was found in config.json and removed. */
	configRemoved: boolean;
}

/** Everything the server process owns. */
export interface Orchestrator {
	bootId: string;
	startedAt: number;
	mfwHome: string;
	projects: Map<string, ProjectServices>;
	log: Logger;
	/** Provider API keys, presence-only (the store itself is process-global,
	 *  not per project: `~/.local/share/mfw/credentials.json`, chmod 600). */
	providers: ProviderSettings;
	/** The one machine-wide provider-truth service; never project-scoped. */
	runpod: RunPodAccountService;
	/** Machine-wide OpenRouter spend and usage observability. */
	openrouter: OpenRouterAccountService;
	/**
	 * The machine-wide master stop, ANDed with every project's own switch.
	 * Process-global so it can be toggled without overwriting each project's
	 * own setting.
	 */
	globalDispatch: GlobalDispatch;
	/** The sole process-global host coordinator and observation-service owner. */
	hostResources: HostResourceCoordinator;
	get(name: string): ProjectServices;
	list(): ProjectServices[];
	/**
	 * Attach a project to the running daemon and persist it to config.json.
	 * Validates before writing.
	 */
	attach(cfg: ProjectConfig): Promise<ProjectServices>;
	/**
	 * Detach a project: stop its loops, close its database, release its lock,
	 * and drop it from config.json. Repository data is never deleted.
	 */
	detach(name: string): Promise<DetachResult>;
	shutdown(): Promise<void>;
}
