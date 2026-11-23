ALTER TABLE `merge_jobs` ADD `verified_sha` text;--> statement-breakpoint
ALTER TABLE `merge_jobs` ADD `rebased_sha` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `verified_sha` text;