CREATE TABLE `brain_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`idem_key` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_run_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`status` text NOT NULL,
	`rejection` text,
	`effects` text,
	`decision_id` integer,
	`created_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_brain_action_idem` ON `brain_actions` (`idem_key`);--> statement-breakpoint
CREATE INDEX `ix_brain_actions_turn` ON `brain_actions` (`turn_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_brain_actions_session` ON `brain_actions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `brain_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`harness` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`endpoint` text,
	`native_session_id` text,
	`last_cost_total` real,
	`native_host` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`generation_started_at` integer NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`wake_hint` text,
	`lease_owner` text,
	`lease_until` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`retry_after` integer,
	`created_at` integer NOT NULL,
	`retired_at` integer,
	`retire_reason` text
);
--> statement-breakpoint
CREATE INDEX `ix_brain_sessions_status` ON `brain_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `brain_turns` (
	`run_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`generation` integer NOT NULL,
	`wake_class` text NOT NULL,
	`events_from` integer NOT NULL,
	`events_to` integer NOT NULL,
	`resumed` integer NOT NULL,
	`status` text NOT NULL,
	`usage` text,
	`actions_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_brain_turn_seq` ON `brain_turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ix_brain_turns_status` ON `brain_turns` (`status`,`started_at`);