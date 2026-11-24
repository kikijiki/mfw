ALTER TABLE `runs` RENAME COLUMN `worktree_path` TO `workspace_path`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `workspace_kind`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `approval_mode`;
