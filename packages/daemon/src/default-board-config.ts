/**
 * The `board.yaml` (at the root of the board folder) a brand-new project gets
 * if it doesn't have one yet (an existing project's own file always wins —
 * this is never copied over one that's already there). Kept in sync by hand
 * with this repo's own `board.yaml`, the canonical mfw task/ADR schema.
 *
 * `key` is interpolated with the project's actually-resolved task key
 * (`resolveTaskKey`, independent of board.yaml and never in sync with it
 * automatically) so a freshly attached project's board.yaml agrees with the
 * ids it will really mint — board-core now validates an id against its
 * type's own-sequence grammar, so a mismatch here would quarantine every id
 * this project writes.
 */
export function defaultBoardYaml(taskKey = "MFW"): string {
	return `mfw: 1

types:
  task:
    layout: directory
    dir: tasks
    primary: task.md
    siblings: [spec.md, files/]
    id: { strategy: own-sequence, key: ${taskKey} }
    slugFrom: title
    fields:
      title: {}
      status:
        values: [draft, backlog, ready, in_progress, blocked, review, done, archived]
        default: backlog
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

  adr:
    layout: flat
    dir: adrs
    id: { strategy: own-sequence, key: ${taskKey}, suffix: ADR }
    slugFrom: title
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

/**
 * Write the default board.yaml when there is none; otherwise upgrade the
 * existing one in place (today: add the task type's `acceptance` checklist,
 * see `tasks/acceptance.ts`). Throws `BoardUpgradeError`, writing nothing,
 * when the existing file conflicts. Returns whether it upgraded a file.
 */
export async function ensureBoardConfig(
	boardFolder: string,
	taskKey = "MFW",
	/** Renders the board.yaml to write when there is none (a board template);
	 * an existing board.yaml is never replaced by it. */
	render: (taskKey: string) => string = defaultBoardYaml,
): Promise<{ upgraded: boolean }> {
	const { existsSync } = await import("node:fs");
	const { join } = await import("node:path");
	const path = join(boardFolder, "board.yaml");
	if (existsSync(path)) {
		const { upgradeBoardYaml } = await import("./tasks/acceptance.ts");
		const { upgradeRoutingFields } = await import("./tasks/routing-fields.ts");
		const acceptance = await upgradeBoardYaml(path);
		// After acceptance: a conflicting acceptance field refuses the attach
		// before anything else is written.
		const routing = await upgradeRoutingFields(path);
		const { upgradeProvenanceFields } = await import(
			"./tasks/provenance-fields.ts"
		);
		const provenance = await upgradeProvenanceFields(path);
		return { upgraded: acceptance || routing || provenance };
	}
	const { writeFileAtomic } = await import("@mfw/board-core");
	await writeFileAtomic(path, render(taskKey));
	return { upgraded: false };
}
