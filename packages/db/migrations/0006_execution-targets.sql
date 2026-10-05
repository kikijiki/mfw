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
CREATE UNIQUE INDEX `uq_run_target_journal_seq` ON `run_target_journal` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ix_run_target_journal_run` ON `run_target_journal` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ix_run_target_journal_phase` ON `run_target_journal` (`phase`,`status`);--> statement-breakpoint
ALTER TABLE `runs` ADD `execution_target` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_project_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_lease_ref` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_execution_path` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_requested_shape` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_observed_shape` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_lifecycle_state` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_cleanup_requested_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `target_absence_confirmed_at` integer;
