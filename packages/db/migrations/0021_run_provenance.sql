ALTER TABLE `runs` ADD `run_dir_layout` text;
--> statement-breakpoint
CREATE TABLE `run_facts` (
	`run_id` text NOT NULL,
	`fact` text NOT NULL,
	`provenance` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`first_observed_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `fact`, `provenance`),
	CONSTRAINT "ck_run_facts_provenance" CHECK(provenance IN ('host-observed', 'sandbox-reported')),
	CONSTRAINT "ck_run_facts_pair" CHECK((fact IN ('exit', 'outcome') AND provenance IN ('host-observed', 'sandbox-reported')) OR (fact IN ('scope') AND provenance IN ('host-observed')) OR (fact IN ('agent_exit_claim', 'report', 'usage', 'usage_live', 'activity', 'capabilities', 'native_session', 'subagents', 'transcript_summary') AND provenance IN ('sandbox-reported')))
);
