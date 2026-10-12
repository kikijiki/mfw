import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) =>
	readFileSync(join(import.meta.dir, "..", "..", path), "utf8");

describe("project attachment placement", () => {
	test("keeps projects out of global Settings", () => {
		const settings = source("features/settings/SettingsPage.tsx");
		expect(settings).not.toContain("ProjectsPanel");
		expect(settings).not.toContain('id="projects"');
		expect(settings).not.toContain('"projects",');
		for (const section of ["providers", "runpod", "openrouter", "appearance"]) {
			expect(settings).toContain(`"${section}"`);
		}
	});

	test("keeps project Play/Stop as the only human dispatch control", () => {
		const config = source("features/settings/ProjectConfig.tsx");
		expect(config).not.toContain("Start work automatically");
		expect(config).not.toContain('set("schedulerAutostart"');
		// Compatibility remains server-side; this assertion is scoped to the form.
		expect(config).not.toContain("patch.schedulerAutostart");
	});

	test("presents parallelism as a brain-planned hard ceiling", () => {
		const config = source("features/settings/ProjectConfig.tsx");
		expect(config).toContain('label="Maximum parallel agents"');
		expect(config).toContain("The brain chooses each wave");
		expect(config).toContain("resource locks and admission may narrow it");
		expect(config).not.toContain('label="Maximum concurrent runs"');
	});

	test("opens project attachment from the sidebar Projects section", () => {
		const shell = source("components/AppShell.tsx");
		const sidebar = shell.slice(
			shell.indexOf("function Sidebar"),
			shell.indexOf("function Divider"),
		);
		expect(sidebar).toContain(">\n\t\t\t\t\t\tProjects");
		expect(sidebar).toContain('aria-label="Add project"');
		expect(sidebar).toContain("setAddingProject(true)");
		expect(shell).toContain("<AddProjectDialog");
		expect(shell).not.toContain("Add one in Settings");
	});

	test("chooses a daemon-visible repository instead of typing a path", () => {
		const picker = source("features/projects/AddProjectDialog.tsx");
		const browser = source("features/projects/DirectoryBrowser.tsx");
		expect(browser).toContain("system.projectDirectory");
		expect(browser).toContain("entry.isRepository");
		expect(picker).toContain("onSelectRepo");
		// The board is inspected live and submitted through the pure builder.
		expect(picker).toContain("system.inspectBoardFolder");
		expect(picker).toContain("system.boardTemplates");
		expect(picker).toContain("buildAddInput(");
		expect(picker).not.toContain("<Input");
		expect(picker).not.toContain('aria-label="Repository root"');
		// The only text field names a NEW folder in the viewed one; it is
		// validated as a single segment, never a typed path.
		const folders = source("features/projects/FolderPicker.tsx");
		expect(folders).toContain('aria-label="New folder name"');
		expect(folders).toContain("validateFolderName(");
		expect(browser).not.toContain("<Input");
	});

	test("keeps shared dialog and Add Project close targets touch-sized on mobile", () => {
		const dialog = source("components/ui/dialog.tsx");
		const picker = source("features/projects/AddProjectDialog.tsx");
		expect(dialog).toContain(
			'className="absolute top-2 right-2 max-md:size-11"',
		);
		expect(picker).toContain('className="max-md:min-h-11"');
		for (const file of [
			"features/projects/DirectoryBrowser.tsx",
			"features/projects/BoardStep.tsx",
			"features/projects/FolderPicker.tsx",
		]) {
			expect(source(file)).toContain("min-h-11");
		}
	});

	test("project removal is detach-only", () => {
		const detach = source("features/projects/DetachProject.tsx");
		expect(detach).toContain("Your code and MFW data are kept");
		expect(detach).toContain("may commit");
		expect(detach).toContain("Adding it again restores the project");
		expect(detach).not.toContain("deleteMfwData");
		expect(detach).not.toContain("delete data");
	});

	test("attachment changes invalidate every fleet-level scheduler read", () => {
		for (const file of [
			"features/projects/AddProjectDialog.tsx",
			"features/projects/DetachProject.tsx",
		]) {
			const contents = source(file);
			expect(contents).toContain("system.scheduler.all.queryFilter()");
			expect(contents).toContain("system.scheduler.status.queryFilter()");
			expect(contents).toContain("system.health.queryFilter()");
		}
	});
});
