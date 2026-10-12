CREATE TABLE `run_subagents` (
	`run_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`parent_tool_use_id` text,
	`agent_type` text NOT NULL,
	`description` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`tools` text NOT NULL,
	`entry_from_seq` integer NOT NULL,
	`entry_to_seq` integer NOT NULL,
	PRIMARY KEY(`run_id`, `tool_use_id`)
);
--> statement-breakpoint
CREATE INDEX `ix_run_subagents_started` ON `run_subagents` (`started_at`);