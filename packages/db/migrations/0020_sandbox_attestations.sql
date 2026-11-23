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
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_sandbox_attestations_run` ON `sandbox_attestations` (`run_id`,`created_at`);