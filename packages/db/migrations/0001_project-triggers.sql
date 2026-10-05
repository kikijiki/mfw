CREATE TABLE `trigger_cursor` (
	`def_id` text PRIMARY KEY NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trigger_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`def_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`exit_code` integer,
	`run_id` text,
	`detail` text,
	`skipped_seqs` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_trigger_deliveries_def` ON `trigger_deliveries` (`def_id`,`event_seq`);--> statement-breakpoint
CREATE INDEX `ix_trigger_deliveries_state` ON `trigger_deliveries` (`state`,`started_at`);