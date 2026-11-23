PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run_facts` (
	`run_id` text NOT NULL,
	`fact` text NOT NULL,
	`provenance` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`first_observed_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `fact`, `provenance`),
	CONSTRAINT "ck_run_facts_provenance" CHECK(provenance IN ('host-observed', 'sandbox-reported')),
	CONSTRAINT "ck_run_facts_pair" CHECK((fact IN ('exit', 'outcome') AND provenance IN ('host-observed', 'sandbox-reported')) OR (fact IN ('scope', 'result_import') AND provenance IN ('host-observed')) OR (fact IN ('agent_exit_claim', 'wip_claim', 'report', 'usage', 'usage_live', 'activity', 'capabilities', 'native_session', 'subagents', 'transcript_summary') AND provenance IN ('sandbox-reported')))
);
--> statement-breakpoint
INSERT INTO `__new_run_facts`("run_id", "fact", "provenance", "value", "source", "first_observed_at", "observed_at") SELECT "run_id", "fact", "provenance", "value", "source", "first_observed_at", "observed_at" FROM `run_facts`;--> statement-breakpoint
DROP TABLE `run_facts`;--> statement-breakpoint
ALTER TABLE `__new_run_facts` RENAME TO `run_facts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;