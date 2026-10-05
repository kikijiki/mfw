CREATE TABLE `dispatch_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`actor` text NOT NULL,
	`state` text NOT NULL,
	`request_key` text NOT NULL,
	`requirements_hash` text NOT NULL,
	`resolution` text NOT NULL,
	`waiter_id` text,
	`waiter_generation` text,
	`host_lease_id` text,
	`host_fence` text,
	`hold_code` text,
	`hold_reason` text,
	`compensation_target` text,
	`owner_boot_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispatch_admissions_request_key_unique` ON `dispatch_admissions` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dispatch_admission_run` ON `dispatch_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `ix_dispatch_admission_task` ON `dispatch_admissions` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_dispatch_admission_state` ON `dispatch_admissions` (`state`,`updated_at`);
