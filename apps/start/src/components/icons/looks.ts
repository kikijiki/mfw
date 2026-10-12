import {
	Archive,
	Ban,
	BookOpen,
	Bug,
	ChevronDown,
	ChevronsUp,
	ChevronUp,
	Circle,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleHelp,
	CircleSlash,
	CircleX,
	Compass,
	Database,
	Diamond,
	Equal,
	Eye,
	Flag,
	FlaskConical,
	Gauge,
	Globe,
	Hammer,
	Hexagon,
	Layers,
	Lightbulb,
	type LucideIcon,
	Map as MapIcon,
	Octagon,
	Package,
	Palette,
	PenLine,
	Pentagon,
	Puzzle,
	Recycle,
	Rocket,
	Search,
	Settings,
	ShieldCheck,
	Sparkles,
	SquareCheck,
	TestTube,
	Triangle,
	Wrench,
} from "lucide-react";

/**
 * One table for "what does this status / task type look like". Pure data (no
 * JSX), so the board, the task page and the tests all read the same icons and
 * words. Rules:
 * - every look is an icon AND a label, never colour alone;
 * - the colour is a `tokens.css` custom property name, never a literal;
 * - status icons are keyed by the board's status ROLE (`board.schema`), so a
 *   project's own status names get the right icon without a table of theirs;
 * - anything unknown gets a deterministic icon + colour from its name, so the
 *   same name always reads the same on every screen.
 */

export interface IconLook {
	icon: LucideIcon;
	/** CSS custom property name from tokens.css. */
	token: string;
	/** The word for it (tooltip, `aria-label`). */
	label: string;
}

/** The eight daemon roles a board status can read as. */
export const STATUS_ROLE_LOOK: Record<string, IconLook> = {
	draft: { icon: PenLine, token: "--mfw-neutral", label: "draft" },
	backlog: {
		icon: CircleDashed,
		token: "--mfw-status-backlog",
		label: "backlog",
	},
	ready: { icon: Circle, token: "--mfw-status-ready", label: "ready" },
	in_progress: {
		icon: CircleDot,
		token: "--mfw-status-in-progress",
		label: "in progress",
	},
	blocked: {
		icon: CircleSlash,
		token: "--mfw-status-blocked",
		label: "blocked",
	},
	review: { icon: Eye, token: "--mfw-status-review", label: "in review" },
	done: { icon: CircleCheck, token: "--mfw-status-done", label: "done" },
	archived: {
		icon: Archive,
		token: "--mfw-status-archived",
		label: "archived",
	},
};

/**
 * Board values with no daemon role that still mean something obvious. Looked
 * up by the value's name only when the role is null.
 */
const STATUS_NAME_LOOK: Record<string, IconLook> = {
	failed: { icon: CircleX, token: "--mfw-critical", label: "failed" },
	failure: { icon: CircleX, token: "--mfw-critical", label: "failed" },
	cancelled: { icon: Ban, token: "--mfw-fg-faint", label: "cancelled" },
	canceled: { icon: Ban, token: "--mfw-fg-faint", label: "cancelled" },
	wontfix: { icon: Ban, token: "--mfw-fg-faint", label: "won't fix" },
};

const FALLBACK_TOKENS = [
	"--mfw-accent",
	"--mfw-info",
	"--mfw-ok",
	"--mfw-warn",
	"--mfw-status-review",
	"--mfw-status-blocked",
] as const;

const STATUS_FALLBACK_ICONS: readonly LucideIcon[] = [
	Hexagon,
	Triangle,
	Diamond,
	Pentagon,
	Octagon,
];

/** FNV-1a: stable across runs and machines. */
export function hashName(name: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

const norm = (s: string) =>
	s
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");

const pick = <T>(list: readonly T[], seed: number): T =>
	list[seed % list.length] as T;

/**
 * The look of a board status. `role` is the daemon role from `board.schema`
 * (null when the board's map cannot place the value); `value` is the board's
 * own value, used for the label and as the fallback seed.
 */
export function statusLook(
	role: string | null | undefined,
	value?: string,
): IconLook {
	if (role) {
		const known = STATUS_ROLE_LOOK[role];
		if (known) return known;
	}
	const name = norm(value ?? role ?? "");
	const byName = STATUS_NAME_LOOK[name];
	if (byName) return byName;
	if (!name)
		return { icon: CircleHelp, token: "--mfw-neutral", label: "status" };
	const seed = hashName(name);
	return {
		icon: pick(STATUS_FALLBACK_ICONS, seed),
		token: pick(FALLBACK_TOKENS, seed >>> 8),
		label: (value ?? role ?? "").replace(/[_-]+/g, " ").trim(),
	};
}

export const TASK_TYPE_LOOK: Record<string, IconLook> = {
	epic: { icon: Layers, token: "--mfw-status-review", label: "epic" },
	feature: { icon: Sparkles, token: "--mfw-accent", label: "feature" },
	bug: { icon: Bug, token: "--mfw-critical", label: "bug" },
	chore: { icon: Wrench, token: "--mfw-neutral", label: "chore" },
	spike: { icon: FlaskConical, token: "--mfw-warn", label: "spike" },
	docs: { icon: BookOpen, token: "--mfw-info", label: "docs" },
	implementation: {
		icon: Hammer,
		token: "--mfw-status-in-progress",
		label: "implementation",
	},
	maintenance: {
		icon: Settings,
		token: "--mfw-neutral",
		label: "maintenance",
	},
	refactor: { icon: Recycle, token: "--mfw-info", label: "refactor" },
	test: { icon: TestTube, token: "--mfw-ok", label: "test" },
	research: { icon: Search, token: "--mfw-status-review", label: "research" },
	task: { icon: SquareCheck, token: "--mfw-neutral", label: "task" },
	story: { icon: Flag, token: "--mfw-accent", label: "story" },
	security: { icon: ShieldCheck, token: "--mfw-critical", label: "security" },
	perf: { icon: Gauge, token: "--mfw-warn", label: "performance" },
	design: { icon: Palette, token: "--mfw-accent", label: "design" },
	release: { icon: Rocket, token: "--mfw-ok", label: "release" },
};

const TYPE_ALIASES: Record<string, string> = {
	bugfix: "bug",
	fix: "bug",
	documentation: "docs",
	doc: "docs",
	tests: "test",
	performance: "perf",
	idea: "spike",
	investigation: "research",
};

const TYPE_FALLBACK_ICONS: readonly LucideIcon[] = [
	Package,
	Puzzle,
	Lightbulb,
	Compass,
	Database,
	Globe,
	MapIcon,
];

/** The look of a task type; an unknown type keeps the same icon and colour everywhere. */
export function taskTypeLook(type: string | null | undefined): IconLook {
	const name = norm(type ?? "");
	if (!name)
		return { icon: CircleHelp, token: "--mfw-neutral", label: "no type" };
	const known = TASK_TYPE_LOOK[TYPE_ALIASES[name] ?? name];
	if (known) return known;
	const seed = hashName(name);
	return {
		icon: pick(TYPE_FALLBACK_ICONS, seed),
		token: pick(FALLBACK_TOKENS, seed >>> 8),
		label: (type ?? "").replace(/[_-]+/g, " ").trim(),
	};
}

/** Task priority: a chevron stack that reads up for urgent, down for low. */
export const PRIORITY_LOOK: Record<string, IconLook> = {
	critical: {
		icon: ChevronsUp,
		token: "--mfw-critical",
		label: "critical priority",
	},
	high: { icon: ChevronUp, token: "--mfw-warn", label: "high priority" },
	medium: { icon: Equal, token: "--mfw-neutral", label: "medium priority" },
	low: { icon: ChevronDown, token: "--mfw-fg-faint", label: "low priority" },
};

/** The look of a priority, or null when the task has none we know. */
export function priorityLook(
	priority: string | null | undefined,
): IconLook | null {
	return PRIORITY_LOOK[norm(priority ?? "")] ?? null;
}
