ALTER TABLE `runs` ADD `workload_secret_grant_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `workload_secret_names` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `workload_secret_binding` text;