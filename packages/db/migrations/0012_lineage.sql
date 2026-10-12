ALTER TABLE `runs` ADD `relation` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `chain_root_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `spawned_by_decision_id` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `origin_ref` text;--> statement-breakpoint
CREATE INDEX `ix_runs_parent` ON `runs` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `ix_runs_chain` ON `runs` (`chain_root_id`);