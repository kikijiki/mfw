import type { TokenPrincipal } from "@mfw/daemon/auth/service";
import type { TokenScope } from "@mfw/daemon/auth/tokens";

/**
 * What an API token may call. Every procedure on the router is declared here,
 * either with the scope it needs or as owner-only, and a test holds this list
 * equal to the router. At runtime anything not declared is refused, so a new
 * procedure is unreachable by tokens until someone decides otherwise.
 *
 * A scope alone is not enough for writes. A task's `verification` holds shell
 * commands, its routing fields choose where work runs, and a task that is not
 * parked in backlog can be promoted and dispatched. So each write names the
 * input fields a token may send: anything else is refused, not ignored.
 */

type Check = (
	input: Record<string, unknown>,
	scopes: readonly TokenScope[],
) => string | null;

// These rules see input only. What a write may do given the task's CURRENT
// state (dispatchable, parked, finished) is enforced under the board lock in
// `TaskService`, from the `token` option the task procedures pass.

interface TokenRule {
	scope: TokenScope;
	/** `global` reads across projects, so a project-restricted token cannot call it. */
	binding: "project" | "global";
	check?: Check;
}

function extraKey(
	value: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	return Object.keys(value).find((k) => !allowed.includes(k));
}

const onlyFields =
	(allowed: readonly string[]): Check =>
	(input) => {
		const extra = extraKey(input, ["project", ...allowed]);
		return extra ? `field '${extra}' is not available to API tokens` : null;
	};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const CREATE_FIELDS = [
	"title",
	"body",
	"type",
	"priority",
	"size",
	"labels",
	"dependsOn",
	"criteria",
	"status",
];
// Not `labels`: a patch replaces the list, and `review:agent` selects the reviewer.
const PATCH_FIELDS = ["title", "body", "priority", "size"];

const checkCreate: Check = (input) => {
	const fields = onlyFields(CREATE_FIELDS)(input, []);
	if (fields) return fields;
	if (input.status !== undefined && input.status !== "backlog")
		return "an API token can only create tasks in backlog";
	if (
		Array.isArray(input.labels) &&
		input.labels.some((l) => typeof l === "string" && /^\s*review:/i.test(l))
	)
		return "an API token cannot set a review label";
	if (
		Array.isArray(input.criteria) &&
		input.criteria.some((c) => isRecord(c) && c.checked === true)
	)
		return "an API token cannot create a criterion already checked";
	return null;
};

const checkUpdate: Check = (input, scopes) => {
	const fields = onlyFields(["id", "baseRev", "patch"])(input, []);
	if (fields) return fields;
	if (!isRecord(input.patch)) return "patch must be an object";
	// Dropping a dependency can release work that was waiting to dispatch.
	const allowed = scopes.includes("runs:act")
		? [...PATCH_FIELDS, "dependsOn"]
		: PATCH_FIELDS;
	const extra = extraKey(input.patch, allowed);
	return extra ? `field '${extra}' is not available to this token` : null;
};

const checkCriteria: Check = (input, scopes) => {
	const fields = onlyFields(["id", "baseRev", "op"])(input, []);
	if (fields) return fields;
	const op = isRecord(input.op) ? input.op.op : undefined;
	if (op === "edit") return null;
	if (op === "add")
		return isRecord(input.op) && input.op.checked === true
			? "an API token cannot add a criterion already checked"
			: null;
	return scopes.includes("runs:act")
		? null
		: "checking or removing a criterion needs the runs:act scope";
};

const checkMove: Check = (input, scopes) => {
	const fields = onlyFields(["id", "to", "reason"])(input, []);
	if (fields) return fields;
	if (input.to === "backlog") return null;
	if (input.to === "ready")
		return scopes.includes("runs:act")
			? null
			: "moving a task to ready dispatches it and needs the runs:act scope";
	return "an API token can only move a task to backlog or ready";
};

const status = (binding: TokenRule["binding"]): TokenRule => ({
	scope: "status:read",
	binding,
});
const boardRead: TokenRule = { scope: "board:read", binding: "project" };
const boardWrite = (check: Check): TokenRule => ({
	scope: "board:write",
	binding: "project",
	check,
});
const runs = (check?: Check): TokenRule => ({
	scope: "runs:act",
	binding: "project",
	...(check ? { check } : {}),
});

export const TOKEN_PROCEDURES: ReadonlyMap<string, TokenRule> = new Map([
	["system.health", status("global")],
	["inbox.list", status("global")],
	["inbox.headlines", status("global")],
	["runs.active", status("global")],
	["system.scheduler.status", status("project")],
	["system.metrics", status("project")],

	["tasks.list", boardRead],
	["tasks.get", boardRead],
	["tasks.graph", boardRead],
	["tasks.getSpec", boardRead],
	["board.schema", boardRead],
	["adrs.list", boardRead],
	["adrs.get", boardRead],
	["clarify.list", boardRead],
	["clarify.get", boardRead],
	["clarify.getForTask", boardRead],
	["system.taskTrace", boardRead],
	["events.list", boardRead],
	["events.latestSeq", boardRead],
	["live.events", boardRead],

	["tasks.create", boardWrite(checkCreate)],
	["tasks.update", boardWrite(checkUpdate)],
	["tasks.criteria", boardWrite(checkCriteria)],
	["tasks.move", boardWrite(checkMove)],

	// Run rows carry the launch argv and prompt, so they are not status.
	["runs.list", runs(onlyFields(["taskId", "limit"]))],
	["runs.get", runs()],
	["runs.entries", runs()],
	["live.runOutput", runs()],
	["runs.startTask", runs(onlyFields(["taskId"]))],
	["runs.stop", runs(onlyFields(["runId"]))],
]);

/** Reachable by an owner session only. Adding here is the safe default. */
export const OWNER_ONLY_PROCEDURES: ReadonlySet<string> = new Set([
	"tasks.ownershipConflicts",
	"tasks.template",
	"tasks.captureQuick",
	"tasks.moveMany",
	"tasks.approve",
	"tasks.reject",
	"tasks.discard",
	"tasks.promoteReady",
	"tasks.remove",
	"tasks.wipe",
	"tasks.setSpec",
	"tasks.listAttachments",
	"tasks.addAttachment",
	"tasks.removeAttachment",
	"adrs.create",
	"adrs.update",
	"adrs.setStatus",
	"adrs.supersede",
	"adrs.remove",
	"docs.sources",
	"docs.entries",
	"docs.read",
	"docs.search",
	"docs.recent",
	"docs.suggestions",
	"docs.adopt",
	"docs.refresh",
	"boardConfig.templates",
	"boardConfig.get",
	"boardConfig.preview",
	"boardConfig.save",
	"brain.session",
	"brain.turns",
	"brain.decisions",
	"brain.plan",
	"brain.intents",
	"brain.states",
	"brain.overridePreview",
	"brain.override",
	"brain.message",
	"brain.giveDirection",
	"brain.directions",
	"brain.chatThread",
	"brain.chatAsk",
	"brain.chatGiveDirection",
	"brain.resetCircuit",
	"brain.setPaused",
	"brain.resolveDecision",
	"brain.resetActBreaker",
	"brain.read",
	"brain.act",
	"budgets.list",
	"budgets.get",
	"budgets.set",
	"node.get",
	"node.story",
	"fleet.summary",
	"flow.tree",
	"flow.at",
	"flow.live",
	"flow.spans",
	"groups.get",
	"groups.addAttempt",
	"groups.selectWinner",
	"holds.pause",
	"holds.resume",
	"holds.list",
	"runs.pipsByTask",
	"runs.listAll",
	"runs.activity",
	"runs.steps",
	"runs.discard",
	"runs.steer",
	"runs.respondApproval",
	"runs.startAction",
	"runs.startPlan",
	"runs.startImport",
	"runs.reroute",
	"review.bundle",
	"review.verdicts",
	"review.latestVerdicts",
	"review.activeMerges",
	"review.mergeJob.retry",
	"review.mergeJob.abandon",
	"review.mergeJob.sendToReady",
	"review.comments.list",
	"review.comments.add",
	"review.comments.resolve",
	"review.comments.remove",
	"review.repairBrief",
	"inbox.dismiss",
	"inbox.prune",
	"system.scheduler.set",
	"system.scheduler.all",
	"system.scheduler.setGlobal",
	"system.scheduler.kick",
	"system.scheduler.hold",
	"system.digest",
	// Host paths and install layout: for the owner, never a token or a brain turn.
	"system.doctor",
	"system.projects",
	"system.projectDirectory",
	"system.inspectBoardFolder",
	"system.boardTemplates",
	"system.addProject",
	"system.removeProject",
	"projects.summary",
	"hostResources.read",
	"hostResources.detect",
	"hostResources.applyDetected",
	"hostResources.audit",
	"hostResources.createDefinition",
	"hostResources.updateDefinition",
	"hostResources.setDrain",
	"hostResources.setEnabled",
	"hostResources.createBinding",
	"hostResources.updateBinding",
	"hostResources.refresh",
	"hostResources.reconcile",
	"hostResources.forceRelease",
	"hosts.list",
	"hosts.add",
	"hosts.remove",
	"hosts.probe",
	"hosts.publicKey",
	"hosts.scanKeys",
	"clarify.open",
	"clarify.answer",
	"clarify.archiveDraft",
	"clarify.dismiss",
	"files.workspaces",
	"files.listDir",
	"files.readFile",
	"files.gitStatus",
	"files.diffFile",
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
	"resources.list",
	"resources.get",
	"resources.register",
	"resources.unregister",
	"resources.forceRelease",
	"runpod.get",
	"runpod.refresh",
	"runpod.updateSafety",
	"runpod.updatePolicy",
	"runpod.setPaused",
	"runpod.cleanup",
	"openrouter.get",
	"openrouter.refresh",
	"settings.get",
	"settings.update",
	"settings.providerHolds.list",
	"settings.providerHolds.clear",
	"settings.providers.catalogue",
	"settings.providers.list",
	"settings.providers.set",
	"settings.providers.remove",
	"triggers.list",
	"triggers.arm",
	"triggers.disarm",
	"triggers.dryRun",
	"triggers.pinPreview",
	"triggers.deliveries",
	"triggers.retry",
	"sessions.open",
	"sessions.list",
	"sessions.get",
	"sessions.start",
	"sessions.resolve",
	"stats.outcomes",
	"stats.reviewers",
	"usage.subscriptions",
	"usage.refresh",
	"usage.changes",
]);

/** Why this token may not make this call, or null when it may. */
export function tokenRefusal(
	principal: TokenPrincipal,
	path: string,
	input: unknown,
): string | null {
	const rule = TOKEN_PROCEDURES.get(path);
	if (!rule) return `'${path}' is not available to API tokens`;
	if (!principal.scopes.includes(rule.scope))
		return `'${path}' needs the ${rule.scope} scope`;
	const fields = isRecord(input) ? input : {};
	if (principal.project !== null) {
		if (rule.binding !== "project")
			return `'${path}' spans projects and is not available to a project token`;
		if (fields.project !== principal.project)
			return "the token was not issued for that project";
	}
	return rule.check?.(fields, principal.scopes) ?? null;
}
