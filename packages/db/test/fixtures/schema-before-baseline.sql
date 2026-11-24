-- The project database schema as the migration chain 0000-0028 left it, read
-- back from sqlite_master after applying that whole chain to an empty database
-- (the chain as of da66e7c8, before it was squashed into 0000_baseline).
-- Frozen: baseline-equivalence.test.ts proves the baseline builds the same schema.

CREATE TABLE `brain_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`idem_key` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_run_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`status` text NOT NULL,
	`rejection` text,
	`effects` text,
	`decision_id` integer,
	`created_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE TABLE `brain_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`harness` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`endpoint` text,
	`native_session_id` text,
	`last_cost_total` real,
	`native_host` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`generation_started_at` integer NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`wake_hint` text,
	`lease_owner` text,
	`lease_until` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`retry_after` integer,
	`created_at` integer NOT NULL,
	`retired_at` integer,
	`retire_reason` text
);
--> statement-breakpoint
CREATE TABLE `brain_turns` (
	`run_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`generation` integer NOT NULL,
	`wake_class` text NOT NULL,
	`events_from` integer NOT NULL,
	`events_to` integer NOT NULL,
	`resumed` integer NOT NULL,
	`status` text NOT NULL,
	`usage` text,
	`actions_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `clarifications` (
	`run_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`goal` text,
	`items` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer
, `continuation_run_id` text);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`role` text NOT NULL,
	`task_id` text,
	`subject_run_id` text,
	`brain_run_id` text,
	`model` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`action` text,
	`reason` text,
	`input` text NOT NULL,
	`output` text NOT NULL,
	`duration_ms` integer,
	`superseded_by` integer,
	`finished_at` integer
, `usage` text, `brain_session_id` text, `turn_run_id` text, `kind` text, `alternatives` text, `confidence` text, `context_refs` text, `harness` text, `outcome` text, `overridden_by` integer);
--> statement-breakpoint
CREATE TABLE `dispatch_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`actor` text NOT NULL,
	`state` text NOT NULL,
	`request_key` text NOT NULL,
	`requirements_hash` text NOT NULL,
	`resolution` text NOT NULL,
	`waiter_id` text,
	`waiter_generation` text,
	`host_lease_id` text,
	`host_fence` text,
	`hold_code` text,
	`hold_reason` text,
	`compensation_target` text,
	`owner_boot_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `engine_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`task_id` text,
	`run_id` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox_dismissals` (
	`item_id` text PRIMARY KEY NOT NULL,
	`dismissed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lifetime_state` (
	`def_id` text PRIMARY KEY NOT NULL,
	`last_fired_at` integer,
	`last_task_id` text,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `merge_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text,
	`branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error` text,
	`enqueued_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `park_retries` integer DEFAULT 0 NOT NULL, `verified_sha` text, `rebased_sha` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`cost` text NOT NULL,
	`max_concurrent` integer DEFAULT 1 NOT NULL,
	`policy` text NOT NULL,
	`metadata` text NOT NULL,
	`last_unlocked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`file` text NOT NULL,
	`line` integer NOT NULL,
	`side` text DEFAULT 'new' NOT NULL,
	`body` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`subject_run_id` text NOT NULL,
	`reviewer_run_id` text,
	`decision_id` integer,
	`mode` text NOT NULL,
	`reviewer_harness` text,
	`reviewer_model` text,
	`round` integer DEFAULT 0 NOT NULL,
	`verdict` text NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`criteria` text DEFAULT '[]' NOT NULL,
	`independent` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_egress` (
	`run_id` text NOT NULL,
	`destination` text NOT NULL,
	`bytes_up` integer DEFAULT 0 NOT NULL,
	`bytes_down` integer DEFAULT 0 NOT NULL,
	`connections` integer DEFAULT 0 NOT NULL,
	`denied` integer DEFAULT 0 NOT NULL,
	`last_denied_reason` text,
	`provenance` text DEFAULT 'host-observed' NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `destination`),
	CONSTRAINT "ck_run_egress_provenance" CHECK(provenance = 'host-observed')
);
--> statement-breakpoint
CREATE TABLE "run_facts" (
	`run_id` text NOT NULL,
	`fact` text NOT NULL,
	`provenance` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`first_observed_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `fact`, `provenance`),
	CONSTRAINT "ck_run_facts_provenance" CHECK(provenance IN ('host-observed', 'sandbox-reported')),
	CONSTRAINT "ck_run_facts_pair" CHECK((fact IN ('exit', 'outcome') AND provenance IN ('host-observed', 'sandbox-reported')) OR (fact IN ('scope', 'result_import') AND provenance IN ('host-observed')) OR (fact IN ('agent_exit_claim', 'wip_claim', 'report', 'usage', 'usage_live', 'activity', 'capabilities', 'native_session', 'subagents', 'transcript_summary') AND provenance IN ('sandbox-reported')))
);
--> statement-breakpoint
CREATE TABLE `run_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`selection` text NOT NULL,
	`status` text NOT NULL,
	`winner_run_id` text,
	`created_by_action` text,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE TABLE `run_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject` text NOT NULL,
	`lane` text NOT NULL,
	`value` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer,
	`detail` text,
	`start_seq` integer,
	`end_seq` integer
);
--> statement-breakpoint
CREATE TABLE `run_steps` (
	`run_id` text NOT NULL,
	`step` text NOT NULL,
	`seq` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`run_id`, `step`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_subagents` (
	`run_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`parent_tool_use_id` text,
	`agent_type` text NOT NULL,
	`description` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`tools` text NOT NULL,
	`entry_from_seq` integer NOT NULL,
	`entry_to_seq` integer NOT NULL,
	PRIMARY KEY(`run_id`, `tool_use_id`)
);
--> statement-breakpoint
CREATE TABLE `run_target_journal` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_lease_ref` text,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`lifecycle_state` text NOT NULL,
	`requested_shape` text,
	`observed_shape` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`task_id` text,
	`parent_run_id` text,
	`label` text NOT NULL,
	`model` text NOT NULL,
	`provider_id` text,
	`cwd` text NOT NULL,
	"workspace_path" text,
	`branch` text,
	`integration_branch` text,
	`base_sha` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`resume_ordinal` integer DEFAULT 0 NOT NULL,
	`max_repairs` integer,
	`argv` text NOT NULL,
	`initial_prompt` text,
	`goal` text,
	`state` text DEFAULT 'starting' NOT NULL,
	`outcome` text,
	`capabilities` text NOT NULL,
	`finalize_owner` text,
	`finalize_claimed_at` integer,
	`exit_code` integer,
	`kill_reason` text,
	`note` text,
	`usage` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
, `reasoning_effort` text, `execution_target` text DEFAULT 'local' NOT NULL, `target_project_id` text, `target_lease_ref` text, `target_execution_path` text, `target_requested_shape` text DEFAULT '{}' NOT NULL, `target_observed_shape` text, `target_lifecycle_state` text DEFAULT 'legacy' NOT NULL, `target_cleanup_requested_at` integer, `target_absence_confirmed_at` integer, `workload_secret_grant_ids` text DEFAULT '[]' NOT NULL, `workload_secret_names` text DEFAULT '[]' NOT NULL, `workload_secret_binding` text, `harness` text, `model_vendor` text, `routing` text, `scope_sample` text, `activity` text, `activity_detail` text, `task_size` text, `task_type` text, `model_tier` text, `host_id` text, `native_session_id` text, `relation` text, `chain_root_id` text, `spawned_by_decision_id` integer, `origin_ref` text, `transcript_summary` text, `usage_live` text, `group_id` text, `role` text, `run_dir_layout` text, `verified_sha` text);
--> statement-breakpoint
CREATE TABLE `sandbox_attestation_uses` (
	`attestation_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandbox_attestations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`version` integer NOT NULL,
	`profile_hash` text NOT NULL,
	`options_hash` text NOT NULL,
	`seccomp_hash` text NOT NULL,
	`bwrap_version` text NOT NULL,
	`scope` text NOT NULL,
	`outcome` text NOT NULL,
	`items` text NOT NULL,
	`pins` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`task_id` text,
	`run_id` text,
	`merge_job_id` integer,
	`title` text NOT NULL,
	`context` text NOT NULL,
	`created_at` integer NOT NULL,
	`opened_run_id` text,
	`opened_at` integer,
	`resolved_at` integer,
	`resolution` text,
	`resolution_reason` text
);
--> statement-breakpoint
CREATE TABLE `spend_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`account_key` text NOT NULL,
	`run_id` text,
	`brain_session_id` text,
	`task_id` text,
	`usd` real,
	`tokens_in` integer,
	`tokens_out` integer,
	`estimated` integer DEFAULT false NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_attempt_outcomes` (
	`root_run_id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`harness` text,
	`model_vendor` text,
	`model` text NOT NULL,
	`effort` text,
	`tier` text,
	`size` text,
	`type` text,
	`target` text,
	`host_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`runs` integer NOT NULL,
	`repairs` integer NOT NULL,
	`review_rounds` integer NOT NULL,
	`first_pass` integer NOT NULL,
	`final` text,
	`verdicts` text DEFAULT '{}' NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`tokens_cached` integer,
	`tokens_reasoning` integer,
	`cost_usd` real,
	`cost_complete` integer NOT NULL,
	`files_changed` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trigger_cursor` (
	`def_id` text PRIMARY KEY NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trigger_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`def_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`exit_code` integer,
	`run_id` text,
	`detail` text,
	`skipped_seqs` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispatch_admissions_request_key_unique` ON `dispatch_admissions` (`request_key`);
--> statement-breakpoint
CREATE INDEX `ix_brain_actions_session` ON `brain_actions` (`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_brain_actions_turn` ON `brain_actions` (`turn_run_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_brain_sessions_status` ON `brain_sessions` (`status`);
--> statement-breakpoint
CREATE INDEX `ix_brain_turns_status` ON `brain_turns` (`status`,`started_at`);
--> statement-breakpoint
CREATE INDEX `ix_clarify_open` ON `clarifications` (`resolved_at`);
--> statement-breakpoint
CREATE INDEX `ix_comments_task` ON `comments` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_decisions_role` ON `decisions` (`role`,`ts`);
--> statement-breakpoint
CREATE INDEX `ix_decisions_subject` ON `decisions` (`subject_run_id`);
--> statement-breakpoint
CREATE INDEX `ix_decisions_task` ON `decisions` (`task_id`,`ts`);
--> statement-breakpoint
CREATE INDEX `ix_dispatch_admission_state` ON `dispatch_admissions` (`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `ix_dispatch_admission_task` ON `dispatch_admissions` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_events_run` ON `events` (`run_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `ix_events_task` ON `events` (`task_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `ix_events_ts` ON `events` (`ts`);
--> statement-breakpoint
CREATE INDEX `ix_events_type` ON `events` (`type`,`seq`);
--> statement-breakpoint
CREATE INDEX `ix_merge_state` ON `merge_jobs` (`state`,`enqueued_at`);
--> statement-breakpoint
CREATE INDEX `ix_outcomes_started` ON `task_attempt_outcomes` (`started_at`);
--> statement-breakpoint
CREATE INDEX `ix_outcomes_task` ON `task_attempt_outcomes` (`task_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `ix_review_comments_task` ON `review_comments` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_review_verdicts_subject` ON `review_verdicts` (`subject_run_id`);
--> statement-breakpoint
CREATE INDEX `ix_review_verdicts_task` ON `review_verdicts` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_run_groups_task` ON `run_groups` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_run_spans_start` ON `run_spans` (`start_ts`);
--> statement-breakpoint
CREATE INDEX `ix_run_spans_subject` ON `run_spans` (`subject`,`lane`,`start_ts`);
--> statement-breakpoint
CREATE INDEX `ix_run_subagents_started` ON `run_subagents` (`started_at`);
--> statement-breakpoint
CREATE INDEX `ix_run_target_journal_phase` ON `run_target_journal` (`phase`,`status`);
--> statement-breakpoint
CREATE INDEX `ix_run_target_journal_run` ON `run_target_journal` (`run_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `ix_runs_chain` ON `runs` (`chain_root_id`);
--> statement-breakpoint
CREATE INDEX `ix_runs_group` ON `runs` (`group_id`);
--> statement-breakpoint
CREATE INDEX `ix_runs_kind` ON `runs` (`kind`,`started_at`);
--> statement-breakpoint
CREATE INDEX `ix_runs_parent` ON `runs` (`parent_run_id`);
--> statement-breakpoint
CREATE INDEX `ix_runs_state` ON `runs` (`state`);
--> statement-breakpoint
CREATE INDEX `ix_runs_task` ON `runs` (`task_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `ix_sandbox_attestations_run` ON `sandbox_attestations` (`run_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_sessions_open` ON `sessions` (`source`,`source_key`,`resolved_at`);
--> statement-breakpoint
CREATE INDEX `ix_sessions_task` ON `sessions` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ix_spend_account_ts` ON `spend_ledger` (`account_key`,`ts`);
--> statement-breakpoint
CREATE INDEX `ix_steps_run` ON `run_steps` (`run_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `ix_trigger_deliveries_def` ON `trigger_deliveries` (`def_id`,`event_seq`);
--> statement-breakpoint
CREATE INDEX `ix_trigger_deliveries_state` ON `trigger_deliveries` (`state`,`started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_brain_action_idem` ON `brain_actions` (`idem_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_brain_turn_seq` ON `brain_turns` (`session_id`,`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dispatch_admission_run` ON `dispatch_admissions` (`run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_merge_run` ON `merge_jobs` (`run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_run_target_journal_seq` ON `run_target_journal` (`run_id`,`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_spend_run_source` ON `spend_ledger` (`run_id`,`source`);
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestation_uses_no_delete` BEFORE DELETE ON `sandbox_attestation_uses`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestation_uses is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestation_uses_no_replace` BEFORE INSERT ON `sandbox_attestation_uses`
WHEN EXISTS (SELECT 1 FROM `sandbox_attestation_uses` WHERE `attestation_id` = NEW.`attestation_id`)
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestation_uses is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestation_uses_no_update` BEFORE UPDATE ON `sandbox_attestation_uses`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestation_uses is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestations_no_delete` BEFORE DELETE ON `sandbox_attestations`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestations_no_replace` BEFORE INSERT ON `sandbox_attestations`
WHEN EXISTS (SELECT 1 FROM `sandbox_attestations` WHERE `id` = NEW.`id`)
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestations_no_update` BEFORE UPDATE ON `sandbox_attestations`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestations is append-only');
END;
