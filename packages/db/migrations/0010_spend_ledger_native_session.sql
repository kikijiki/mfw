CREATE TABLE `spend_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`account_key` text NOT NULL,
	`run_id` text,
	`brain_session_id` text,
	`task_id` text,
	`usd` real,
	`tokens_in` integer,
	`tokens_out` integer,
	`estimated` integer DEFAULT false NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_spend_account_ts` ON `spend_ledger` (`account_key`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_spend_run_source` ON `spend_ledger` (`run_id`,`source`);--> statement-breakpoint
ALTER TABLE `decisions` ADD `brain_session_id` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `turn_run_id` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `alternatives` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `confidence` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `context_refs` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `harness` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `overridden_by` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `native_session_id` text;