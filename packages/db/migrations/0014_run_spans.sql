CREATE TABLE `run_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject` text NOT NULL,
	`lane` text NOT NULL,
	`value` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer,
	`detail` text,
	`start_seq` integer,
	`end_seq` integer
);
--> statement-breakpoint
CREATE INDEX `ix_run_spans_subject` ON `run_spans` (`subject`,`lane`,`start_ts`);--> statement-breakpoint
CREATE INDEX `ix_run_spans_start` ON `run_spans` (`start_ts`);