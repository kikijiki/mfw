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
	`pins` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_sandbox_attestations_run` ON `sandbox_attestations` (`run_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestations_no_update` BEFORE UPDATE ON `sandbox_attestations`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestations_no_delete` BEFORE DELETE ON `sandbox_attestations`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestations_no_replace` BEFORE INSERT ON `sandbox_attestations`
WHEN EXISTS (SELECT 1 FROM `sandbox_attestations` WHERE `id` = NEW.`id`)
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestations is append-only');
END;
--> statement-breakpoint
CREATE TABLE `sandbox_attestation_uses` (
	`attestation_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestation_uses_no_update` BEFORE UPDATE ON `sandbox_attestation_uses`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestation_uses is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestation_uses_no_delete` BEFORE DELETE ON `sandbox_attestation_uses`
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestation_uses is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `sandbox_attestation_uses_no_replace` BEFORE INSERT ON `sandbox_attestation_uses`
WHEN EXISTS (SELECT 1 FROM `sandbox_attestation_uses` WHERE `attestation_id` = NEW.`attestation_id`)
BEGIN
	SELECT RAISE(ABORT, 'sandbox_attestation_uses is append-only');
END;
