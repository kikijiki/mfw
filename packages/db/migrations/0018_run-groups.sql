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
CREATE INDEX `ix_run_groups_task` ON `run_groups` (`task_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `runs` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `role` text;--> statement-breakpoint
CREATE INDEX `ix_runs_group` ON `runs` (`group_id`);