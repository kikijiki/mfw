CREATE TABLE `clarifications` (
	`run_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`goal` text,
	`items` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_clarify_open` ON `clarifications` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_comments_task` ON `comments` (`task_id`,`created_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `ix_decisions_task` ON `decisions` (`task_id`,`ts`);--> statement-breakpoint
CREATE INDEX `ix_decisions_role` ON `decisions` (`role`,`ts`);--> statement-breakpoint
CREATE INDEX `ix_decisions_subject` ON `decisions` (`subject_run_id`);--> statement-breakpoint
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
CREATE INDEX `ix_events_task` ON `events` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ix_events_type` ON `events` (`type`,`seq`);--> statement-breakpoint
CREATE INDEX `ix_events_ts` ON `events` (`ts`);--> statement-breakpoint
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
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_merge_run` ON `merge_jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `ix_merge_state` ON `merge_jobs` (`state`,`enqueued_at`);--> statement-breakpoint
CREATE TABLE `resource_slots` (
	`resource_id` text NOT NULL,
	`slot` integer NOT NULL,
	`run_id` text NOT NULL,
	`locked_at` integer NOT NULL,
	PRIMARY KEY(`resource_id`, `slot`),
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_slots_run` ON `resource_slots` (`run_id`);--> statement-breakpoint
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
CREATE INDEX `ix_review_comments_task` ON `review_comments` (`task_id`,`created_at`);--> statement-breakpoint
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
CREATE INDEX `ix_steps_run` ON `run_steps` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`task_id` text,
	`parent_run_id` text,
	`label` text NOT NULL,
	`model` text NOT NULL,
	`provider_id` text,
	`cwd` text NOT NULL,
	`worktree_path` text,
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
);
--> statement-breakpoint
CREATE INDEX `ix_runs_state` ON `runs` (`state`);--> statement-breakpoint
CREATE INDEX `ix_runs_task` ON `runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `ix_runs_kind` ON `runs` (`kind`,`started_at`);