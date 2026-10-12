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
CREATE INDEX `ix_review_verdicts_task` ON `review_verdicts` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_review_verdicts_subject` ON `review_verdicts` (`subject_run_id`);--> statement-breakpoint
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
CREATE INDEX `ix_outcomes_task` ON `task_attempt_outcomes` (`task_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `ix_outcomes_started` ON `task_attempt_outcomes` (`started_at`);--> statement-breakpoint
ALTER TABLE `decisions` ADD `usage` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `harness` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_vendor` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `routing` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `scope_sample` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `activity` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `activity_detail` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `task_size` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `task_type` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_tier` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `host_id` text;