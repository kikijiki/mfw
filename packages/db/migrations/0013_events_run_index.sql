CREATE INDEX `ix_events_run` ON `events` (`run_id`,`seq`);--> statement-breakpoint
UPDATE `events` SET `task_id` = (SELECT `task_id` FROM `runs` WHERE `runs`.`id` = `events`.`run_id`) WHERE `task_id` IS NULL AND `run_id` IS NOT NULL;
