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
CREATE INDEX `ix_sessions_open` ON `sessions` (`source`,`source_key`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `ix_sessions_task` ON `sessions` (`task_id`,`created_at`);