CREATE TABLE `run_egress` (
	`run_id` text NOT NULL,
	`destination` text NOT NULL,
	`bytes_up` integer DEFAULT 0 NOT NULL,
	`bytes_down` integer DEFAULT 0 NOT NULL,
	`connections` integer DEFAULT 0 NOT NULL,
	`denied` integer DEFAULT 0 NOT NULL,
	`last_denied_reason` text,
	`provenance` text DEFAULT 'host-observed' NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `destination`),
	CONSTRAINT "ck_run_egress_provenance" CHECK(provenance = 'host-observed')
);
