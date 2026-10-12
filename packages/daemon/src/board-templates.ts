/**
 * The catalogue of predefined boards the add-project flow can offer when a
 * project needs a `board.yaml` of its own. Pure data: statuses, workflow
 * classes, transitions and a `yaml(taskKey)` rendering the full board file
 * for the project's task key. Nothing here writes a file or touches a
 * project; the attach flow picks a template and renders it.
 *
 * Every rendered yaml parses with `parseBoardConfig` once the `x-mfw-daemon`
 * block is removed (board-core's schema is strict), and every yaml carries
 * that block: the daemon-role map (`statusMap`) saying which of this board's
 * status values fill each daemon role (draft/backlog/ready/...), first value
 * = the one written. Roles the board cannot express are `[]`, and every
 * status value belongs to exactly one role.
 */

import { defaultBoardYaml } from "./default-board-config.ts";

/** The daemon roles a board's status values map onto, in daemon order. */
const STATUS_ROLES = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
] as const;

export interface BoardTemplate {
	id: string;
	title: string;
	description: string;
	statuses: string[];
	/** The full `board.yaml` text for this board, with the task/ADR id key
	 * (e.g. `POOT`) interpolated into every own-sequence id. */
	yaml(taskKey: string): string;
}

/** The `x-mfw-daemon` extension block: daemon role -> board status values. */
function statusMapBlock(
	statusMap: Readonly<Record<string, readonly string[]>>,
): string {
	const lines = ["", "x-mfw-daemon:", "  statusMap:"];
	for (const role of STATUS_ROLES) {
		lines.push(`    ${role}: [${(statusMap[role] ?? []).join(", ")}]`);
	}
	return `${lines.join("\n")}\n`;
}

/** `defaultBoardYaml` with this template's workflow keys spliced into the
 * task type (before `adr:`), so the default's fields, layout and comments
 * stay byte for byte. */
function withWorkflow(yaml: string, taskWorkflow: string): string {
	const at = yaml.indexOf("\n  adr:\n");
	if (at < 0) {
		throw new Error("board template: default board.yaml has no adr type");
	}
	return `${yaml.slice(0, at)}\n${taskWorkflow}${yaml.slice(at)}`;
}

/** A flat-layout board (tasks are `<ID>.md`) with the default's task/adr
 * field list, this template's status values, and its workflow keys. */
function flatBoardYaml(
	taskKey: string,
	statuses: readonly string[],
	defaultStatus: string,
	taskWorkflow: string,
): string {
	return `mfw: 1

types:
  task:
    layout: flat
    dir: tasks
    id: { strategy: own-sequence, key: ${taskKey} }
    fields:
      title: {}
      status:
        values: [${statuses.join(", ")}]
        default: ${defaultStatus}
      type:
        values: [implementation, spike, epic, maintenance]
        default: implementation
      priority:
        values: [critical, high, medium, low]
        default: medium
      size:
        values: [xs, s, m, l, xl]
        optional: true
      labels: { list: true, optional: true }
      parent: { ref: task, optional: true }
      depends_on: { ref: task, list: true, acyclic: true, optional: true }
      owns: { list: true, optional: true }
      spike_timebox: { optional: true }
      requires_resources: { type: json, list: true, optional: true }
      execution_target: { default: local }
      local_staging_resources: { type: json, list: true, optional: true }
      workload_secret_grants: { list: true, optional: true }
      require_review: { type: boolean, default: false }
      created: { optional: true }
      source:
        values: [human, planner, importer, lifetime, split, followup]
        default: human
      split_from: { ref: task, optional: true }
      lifetime_def: { optional: true }
      blocked_reason: { optional: true }
      draft_prompt: { optional: true }
      after_expansion:
        values: [backlog, ready]
        default: ready
      ready_mode:
        values: [automatic, manual]
        default: automatic
      capture_id: { optional: true }
      model_tier:
        values: [light, standard, strong]
        optional: true
      # Routing pins (see backstage architecture.md, "Routing"): a harness (claude-cli,
      # codex-cli) or a project endpoint id, and an exact model id. Unset =
      # the project decides (tier map, then catalogue).
      provider: { optional: true, pattern: '[A-Za-z0-9_-]+' }
      model: { optional: true }
      discovered_from: { ref: task, optional: true }
      discovery_key: { optional: true }
      # Provenance: who wrote the task (a person's tasks carry none), the
      # brain action that last edited it, and the task that replaced it.
      created_by: { optional: true }
      edited_by: { optional: true }
      superseded_by: { optional: true }
      reopen_when: { type: json, list: true, optional: true }
      # The Definition of Done: {verifier, checks[]}. A real frontmatter field,
      # not a fenced body block — the daemon's finalize pipeline EXECUTES this.
      verification: { type: json, optional: true }
      # Acceptance criteria: observable outcomes the critic assesses, as
      # {id, text, done} items. A checklist so this type's rules can gate on
      # them (e.g. forbid: { done: false } when: { status: done }).
      acceptance: { type: checklist, optional: true }
${taskWorkflow}
  adr:
    layout: flat
    dir: adrs
    id: { strategy: own-sequence, key: ${taskKey}, suffix: ADR }
    fields:
      title: {}
      status:
        values: [proposed, accepted, superseded, rejected]
        default: proposed
      date: { optional: true }
      supersedes: { ref: adr, optional: true }
      superseded_by: { ref: adr, optional: true }
`;
}

const MFW_DEFAULT_WORKFLOW = `    statusClasses:
      terminal: [done, archived]
      live: [draft, backlog, ready, in_progress, blocked, review]
      parked: []
      queued: [ready]
    ready: { dependsOn: depends_on }
    transitions:
      start: { from: [draft, backlog, ready], to: in_progress }
      block: { from: [in_progress, review], to: blocked, arg: blocked_reason }
      unblock: { from: [blocked], to: in_progress, clear: [blocked_reason] }
      review: { from: [in_progress], to: review }
      finish: { from: [review], to: done }
      archive: { from: [done], to: archived }
      reopen: { from: [done, archived], to: backlog }
`;

const KANBAN_WORKFLOW = `    statusClasses:
      terminal: [done]
      live: [todo, doing, review]
      parked: []
      queued: [todo]
    ready: { dependsOn: depends_on }
    transitions:
      start: { from: [todo], to: doing }
      review: { from: [doing], to: review }
      send_back: { from: [review], to: doing }
      finish: { from: [review], to: done }
      reopen: { from: [done], to: todo }
`;

const PLANNING_WORKFLOW = `    statusClasses:
      terminal: [done, retired]
      live: [planned, doing]
      parked: [deferred, dropped]
      queued: [planned]
    ready: { dependsOn: depends_on }
    transitions:
      start: { from: [planned], to: doing }
      finish: { from: [doing], to: done }
      defer: { from: [planned, doing], to: deferred }
      resume: { from: [deferred], to: planned }
      drop: { from: [planned, doing, deferred], to: dropped }
      retire: { from: [done], to: retired }
      reopen: { from: [retired], to: planned }
`;

const JIRA_LIKE_WORKFLOW = `    statusClasses:
      terminal: [done]
      live: [todo, in_progress, in_review, blocked]
      parked: []
      queued: [todo]
    ready: { dependsOn: depends_on }
    transitions:
      start: { from: [todo], to: in_progress }
      review: { from: [in_progress], to: in_review }
      block: { from: [todo, in_progress, in_review], to: blocked, arg: blocked_reason }
      unblock: { from: [blocked], to: in_progress, clear: [blocked_reason] }
      finish: { from: [in_review], to: done }
      reopen: { from: [done], to: todo }
`;

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
	{
		id: "mfw-default",
		title: "mfw default",
		description:
			"The full mfw task/ADR schema: draft, backlog, ready, in_progress, blocked, review, done, archived.",
		statuses: [
			"draft",
			"backlog",
			"ready",
			"in_progress",
			"blocked",
			"review",
			"done",
			"archived",
		],
		yaml: (taskKey) =>
			withWorkflow(defaultBoardYaml(taskKey), MFW_DEFAULT_WORKFLOW) +
			statusMapBlock({
				draft: ["draft"],
				backlog: ["backlog"],
				ready: ["ready"],
				in_progress: ["in_progress"],
				blocked: ["blocked"],
				review: ["review"],
				done: ["done"],
				archived: ["archived"],
			}),
	},
	{
		id: "kanban",
		title: "Kanban",
		description: "Minimal columns: todo, doing, review, done.",
		statuses: ["todo", "doing", "review", "done"],
		yaml: (taskKey) =>
			flatBoardYaml(
				taskKey,
				["todo", "doing", "review", "done"],
				"todo",
				KANBAN_WORKFLOW,
			) +
			statusMapBlock({
				draft: [],
				backlog: [],
				ready: ["todo"],
				in_progress: ["doing"],
				blocked: [],
				review: ["review"],
				done: ["done"],
				archived: [],
			}),
	},
	{
		id: "planning",
		title: "Planning",
		description:
			"planned, doing and done, with deferred, dropped and retired parks.",
		statuses: ["planned", "doing", "done", "deferred", "dropped", "retired"],
		yaml: (taskKey) =>
			flatBoardYaml(
				taskKey,
				["planned", "doing", "done", "deferred", "dropped", "retired"],
				"planned",
				PLANNING_WORKFLOW,
			) +
			statusMapBlock({
				draft: [],
				backlog: [],
				ready: ["planned"],
				in_progress: ["doing"],
				blocked: ["deferred"],
				review: [],
				done: ["done"],
				archived: ["dropped", "retired"],
			}),
	},
	{
		id: "jira-like",
		title: "Jira-like",
		description:
			"Jira's flow with lowercase ids: To Do, In Progress, In Review, Blocked, Done.",
		statuses: ["todo", "in_progress", "in_review", "blocked", "done"],
		yaml: (taskKey) =>
			flatBoardYaml(
				taskKey,
				["todo", "in_progress", "in_review", "blocked", "done"],
				"todo",
				JIRA_LIKE_WORKFLOW,
			) +
			statusMapBlock({
				draft: [],
				backlog: [],
				ready: ["todo"],
				in_progress: ["in_progress"],
				blocked: ["blocked"],
				review: ["in_review"],
				done: ["done"],
				archived: [],
			}),
	},
];

export function getBoardTemplate(id: string): BoardTemplate | undefined {
	return BOARD_TEMPLATES.find((template) => template.id === id);
}
