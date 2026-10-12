import {
	Ban,
	BellRing,
	Check,
	ChevronRight,
	Circle,
	CircleAlert,
	CircleDashed,
	CircleHelp,
	CirclePause,
	Clock,
	CornerDownRight,
	Diamond,
	Ellipsis,
	Eye,
	Flag,
	GitCompareArrows,
	GitFork,
	GitMerge,
	Hand,
	Hourglass,
	LoaderCircle,
	type LucideIcon,
	OctagonX,
	Pause,
	Play,
	RefreshCw,
	Repeat,
	Scale,
	Square,
	Star,
	TriangleAlert,
	Wrench,
	X,
} from "lucide-react";

/**
 * The one registry of small state / event marks (never emoji, never text
 * symbols): every place that used to print a glyph character names one of
 * these keys and draws it as an inline SVG, monochrome (`currentColor`).
 * The key is an ASCII word, so it is also what tests, `data-glyph` and
 * `flowModel` carry. A `solid` mark is drawn filled.
 */
export const GLYPHS = {
	dot: { icon: Circle, solid: true },
	ring: { icon: Circle },
	question: { icon: CircleHelp },
	alert: { icon: CircleAlert },
	dashed: { icon: CircleDashed },
	square: { icon: Square, solid: true },
	clock: { icon: Clock },
	loader: { icon: LoaderCircle },
	merge: { icon: GitMerge },
	check: { icon: Check },
	cross: { icon: X },
	stop: { icon: Ban },
	hourglass: { icon: Hourglass },
	eye: { icon: Eye },
	star: { icon: Star, solid: true },
	diamond: { icon: Diamond },
	diamond_solid: { icon: Diamond, solid: true },
	paused: { icon: CirclePause },
	stuck: { icon: OctagonX },
	hand: { icon: Hand },
	flag: { icon: Flag },
	scale: { icon: Scale },
	pause: { icon: Pause },
	fork: { icon: GitFork },
	compete: { icon: GitCompareArrows },
	repair: { icon: Wrench },
	play: { icon: Play },
	reply: { icon: CornerDownRight },
	refresh: { icon: RefreshCw },
	repeat: { icon: Repeat },
	chevron: { icon: ChevronRight },
	more: { icon: Ellipsis },
	ask: { icon: BellRing },
	needs: { icon: TriangleAlert },
} as const satisfies Record<string, { icon: LucideIcon; solid?: boolean }>;

export type GlyphName = keyof typeof GLYPHS;

/** The registry entry for a name; an unknown name reads as the plain dot. */
export function glyphOf(name: string): { icon: LucideIcon; solid: boolean } {
	const table = GLYPHS as Record<string, { icon: LucideIcon; solid?: boolean }>;
	const g = table[name] ?? GLYPHS.dot;
	return { icon: g.icon, solid: "solid" in g && g.solid === true };
}
