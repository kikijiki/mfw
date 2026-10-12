/**
 * The add-project flow as pure functions: what a board folder's inspection
 * means, what the dialog may submit, and the plain-language summary shown
 * before the Add button. No React, no queries: the dialog only feeds these.
 */
import type { RouterInputs, RouterOutputs } from "~/lib/trpc";

export type Inspection = RouterOutputs["system"]["inspectBoardFolder"];
export type BoardTemplateInfo =
	RouterOutputs["system"]["boardTemplates"][number];
export type AddProjectInput = RouterInputs["system"]["addProject"];

export const DEFAULT_TEMPLATE_ID = "mfw-default";

/** Where the board goes: inside the repository, or in another folder (which may not exist yet). */
export type BoardChoice =
	| { kind: "repo" }
	| { kind: "folder"; path: string; create: boolean };

export interface AddState {
	repo: string | null;
	board: BoardChoice;
	/** A BOARD_TEMPLATES id; only used when the board folder has no board. */
	template: string | null;
}

export type InspectionKind =
	| "loading"
	| "new-folder"
	| "none"
	| "existing"
	| "legacy"
	| "ambiguous"
	| "invalid";

export interface InspectionView {
	kind: InspectionKind;
	tone: "neutral" | "success" | "warning" | "error";
	title: string;
	detail: string;
	canAdd: boolean;
	needsTemplate: boolean;
	/** Existing board only: the task type's statuses with counts and daemon roles, declaration order. */
	statuses: { name: string; count: number; role: string | null }[];
	tasks: number | null;
	layout: "flat" | "directory" | null;
}

const NO_BOARD: Pick<InspectionView, "statuses" | "tasks" | "layout"> = {
	statuses: [],
	tasks: null,
	layout: null,
};

function taskType(inspection: Inspection) {
	return (
		inspection.types.find((type) => type.name === "task") ??
		inspection.types[0] ??
		null
	);
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** What a board folder's inspection means for the user, and whether it allows Add. */
export function describeInspection(
	inspection: Inspection | null | undefined,
): InspectionView {
	if (!inspection) {
		return {
			kind: "loading",
			tone: "neutral",
			title: "Looking for a board…",
			detail: "",
			canAdd: false,
			needsTemplate: false,
			...NO_BOARD,
		};
	}
	if (!inspection.exists) {
		return {
			kind: "new-folder",
			tone: "neutral",
			title: "New folder",
			detail: `${inspection.path} does not exist yet. It will be created with a new board.`,
			canAdd: true,
			needsTemplate: true,
			...NO_BOARD,
		};
	}
	if (inspection.location === "ambiguous") {
		return {
			kind: "ambiguous",
			tone: "error",
			title: "Two boards in this folder",
			detail: `Both ${inspection.path}/board.yaml and ${inspection.path}/.mfw/board.yaml exist. Remove one and try again.`,
			canAdd: false,
			needsTemplate: false,
			...NO_BOARD,
		};
	}
	if (inspection.location === "none") {
		return {
			kind: "none",
			tone: "neutral",
			title: "No board here yet",
			detail: "Pick a template for the new board.",
			canAdd: true,
			needsTemplate: true,
			...NO_BOARD,
		};
	}
	if (!inspection.valid) {
		return {
			kind: "invalid",
			tone: "error",
			title: "This board cannot be read",
			detail: inspection.error ?? "board.yaml is not valid.",
			canAdd: false,
			needsTemplate: false,
			...NO_BOARD,
		};
	}
	if (inspection.statusMapError) {
		return {
			kind: "invalid",
			tone: "error",
			title: "This board's statuses are not mapped",
			detail: inspection.statusMapError,
			canAdd: false,
			needsTemplate: false,
			...NO_BOARD,
		};
	}
	const type = taskType(inspection);
	const roles = inspection.statusRoles ?? {};
	const statuses = (type?.statuses ?? []).map((name) => ({
		name,
		count: type?.statusCounts[name] ?? 0,
		role: roles[name] ?? null,
	}));
	const tasks = type?.documents ?? 0;
	const layout = type?.layout ?? null;
	if (inspection.location === "legacy-mfw") {
		return {
			kind: "legacy",
			tone: "warning",
			title: "Board found in .mfw/",
			detail: `It holds ${plural(tasks, "task")} and will be moved to the folder root.`,
			canAdd: true,
			needsTemplate: false,
			statuses,
			tasks,
			layout,
		};
	}
	return {
		kind: "existing",
		tone: "success",
		title: "Existing board found",
		detail: `${plural(tasks, "task")}${layout ? `, ${layout} layout` : ""}. It is used as it is, never overwritten.`,
		canAdd: true,
		needsTemplate: false,
		statuses,
		tasks,
		layout,
	};
}

/** The folder the board will live in, or null before a repository is chosen. */
export function boardFolderOf(state: AddState): string | null {
	if (state.board.kind === "folder") return state.board.path;
	return state.repo;
}

/** Whether the board folder needs an inspection query (a folder still to be created has nothing to inspect). */
export function needsInspection(state: AddState): boolean {
	if (!boardFolderOf(state)) return false;
	return !(state.board.kind === "folder" && state.board.create);
}

/** The inspection to describe: a folder to be created is "does not exist" by construction. */
export function effectiveInspection(
	state: AddState,
	queried: Inspection | null | undefined,
): Inspection | null {
	const folder = boardFolderOf(state);
	if (folder && state.board.kind === "folder" && state.board.create) {
		return {
			path: folder,
			exists: false,
			isGitRepo: false,
			location: "none",
			boardYaml: null,
			valid: false,
			error: null,
			key: null,
			types: [],
			statusRoles: null,
			statusMapError: null,
		};
	}
	// A stale answer for another folder must never describe this one.
	if (queried && folder && queried.path !== folder) return null;
	return queried ?? null;
}

/**
 * What `addProject` receives, or null when Add must be disabled. `boardRoot`
 * only when the board is somewhere other than the repository, `template` only
 * when there is no board yet, `createBoardFolder` only for a folder that does
 * not exist.
 */
export function buildAddInput(
	state: AddState,
	inspection: Inspection | null | undefined,
	templates: readonly BoardTemplateInfo[] = [],
): AddProjectInput | null {
	if (!state.repo) return null;
	const view = describeInspection(inspection);
	if (!view.canAdd) return null;
	const input: AddProjectInput = { root: state.repo };
	if (state.board.kind === "folder" && state.board.path !== state.repo) {
		input.boardRoot = state.board.path;
		if (inspection && !inspection.exists) input.createBoardFolder = true;
	}
	if (view.needsTemplate) {
		const chosen = state.template ?? DEFAULT_TEMPLATE_ID;
		if (templates.length > 0 && !templates.some((t) => t.id === chosen)) {
			return null;
		}
		input.template = chosen;
	}
	return input;
}

export interface SummaryLine {
	label: string;
	value: string;
}

const basename = (path: string) =>
	path.replace(/\/+$/, "").split("/").pop() || path;

/** The "what will happen" list above the Add button. */
export function summarize(
	state: AddState,
	inspection: Inspection | null | undefined,
	templates: readonly BoardTemplateInfo[] = [],
): SummaryLine[] {
	if (!state.repo) return [];
	const view = describeInspection(inspection);
	const folder = boardFolderOf(state) ?? state.repo;
	const lines: SummaryLine[] = [
		{ label: "Repository", value: state.repo },
		{
			label: "Board folder",
			value:
				folder === state.repo ? `${folder} (inside the repository)` : folder,
		},
	];
	const template = templates.find(
		(t) => t.id === (state.template ?? DEFAULT_TEMPLATE_ID),
	);
	switch (view.kind) {
		case "loading":
			lines.push({ label: "Board", value: "checking…" });
			break;
		case "new-folder":
		case "none":
			lines.push({
				label: "Board",
				value: `a new ${template ? `"${template.title}"` : "default"} board.yaml will be written${view.kind === "new-folder" ? " in a folder created for it" : ""}`,
			});
			break;
		case "existing":
			lines.push({
				label: "Board",
				value: `existing board adopted as it is (${plural(view.tasks ?? 0, "task")})`,
			});
			break;
		case "legacy":
			lines.push({
				label: "Board",
				value: "the board in .mfw/ moves to the folder root",
			});
			break;
		default:
			lines.push({ label: "Board", value: view.title });
	}
	lines.push({
		label: "Kept in the repository",
		value: `${basename(state.repo)}/.mfw holds runs, worktrees and the index`,
	});
	return lines;
}

/** A folder name typed to create a board folder: one path segment, nothing that escapes. */
export function validateFolderName(raw: string): string | null {
	const name = raw.trim();
	if (!name) return "Enter a folder name.";
	if (name === "." || name === "..") return "Use a plain folder name.";
	if (/[\\/\0]/.test(name)) return "A folder name cannot contain slashes.";
	return null;
}

export function joinPath(dir: string, name: string): string {
	return `${dir.replace(/\/+$/, "")}/${name.trim()}`;
}

export interface FolderSuggestion {
	path: string;
	label: string;
	/** True when the folder does not exist yet and will be created. */
	create: boolean;
	reason: "recent" | "sibling" | "new";
}

/**
 * Where a repository's board might live: folders used before, existing
 * sibling folders that are not repositories and look like board or docs
 * folders (or are named after the repository), and one new sibling
 * `<repo>-board` to create.
 */
export function suggestFolders(input: {
	repo: string;
	siblings: readonly { name: string; path: string; isRepository: boolean }[];
	recent: readonly string[];
	limit?: number;
}): FolderSuggestion[] {
	const repoName = basename(input.repo);
	const parent = input.repo.slice(0, input.repo.lastIndexOf("/")) || "/";
	const out: FolderSuggestion[] = [];
	const seen = new Set<string>([input.repo]);
	const add = (s: FolderSuggestion) => {
		if (seen.has(s.path)) return;
		seen.add(s.path);
		out.push(s);
	};
	for (const path of input.recent) {
		add({ path, label: basename(path), create: false, reason: "recent" });
	}
	for (const entry of input.siblings) {
		if (entry.isRepository || entry.path === input.repo) continue;
		if (
			entry.name.startsWith(repoName) ||
			/board|docs|plan|tasks|notes/i.test(entry.name)
		) {
			add({
				path: entry.path,
				label: entry.name,
				create: false,
				reason: "sibling",
			});
		}
	}
	const fresh = joinPath(parent, `${repoName}-board`);
	add({ path: fresh, label: `${repoName}-board`, create: true, reason: "new" });
	return out.slice(0, input.limit ?? 5);
}
