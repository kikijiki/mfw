/**
 * The `.mfw/board.yaml` a brand-new project gets if it doesn't have one yet
 * (an existing project's own file always wins — this is never copied over
 * one that's already there). Kept in sync by hand with this repo's own
 * `.mfw/board.yaml`, which is the canonical mfw task/ADR schema.
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
      discovered_from: { ref: task, optional: true }
      discovery_key: { optional: true }
      reopen_when: { type: json, list: true, optional: true }
      # The Definition of Done: {verifier, checks[]}. A real frontmatter field,
      # not a fenced body block — the daemon's finalize pipeline EXECUTES this,
      # so it must stay structured, unlike the (purely documentary, never
      # trusted as evidence) "## Acceptance Criteria" prose, which is just body
      # markdown now.
      verification: { type: json, optional: true }

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

export async function ensureBoardConfig(
	mfwDir: string,
	taskKey = "MFW",
): Promise<void> {
	const { existsSync } = await import("node:fs");
	const { join } = await import("node:path");
	const path = join(mfwDir, "board.yaml");
	if (existsSync(path)) return;
	const { writeFileAtomic } = await import("@mfw/board-core");
	await writeFileAtomic(path, defaultBoardYaml(taskKey));
}
