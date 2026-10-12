import {
	type ProjectIconKey,
	resolveAvatar,
} from "@mfw/daemon/project-appearance";
import { useQuery } from "@tanstack/react-query";
import {
	BookOpen,
	Box,
	Brain,
	Bug,
	Calendar,
	Camera,
	ChartColumn,
	Clock,
	Cloud,
	Code,
	Cog,
	Compass,
	Cpu,
	Database,
	Film,
	Flag,
	FlaskConical,
	Folder,
	Gamepad2,
	Globe,
	Heart,
	House,
	Image,
	Key,
	Layers,
	Leaf,
	Lock,
	type LucideIcon,
	Mail,
	Map as MapIcon,
	MessageSquare,
	Music,
	Package,
	Palette,
	Phone,
	Rocket,
	Server,
	Shield,
	ShoppingCart,
	Star,
	Tag,
	Terminal,
	Wallet,
	Wrench,
	Zap,
} from "lucide-react";
import { useMemo } from "react";
import { cn } from "~/lib/utils";
import { useTRPC } from "../../lib/trpc";

/** Every curated key and the glyph it draws. Keys are the daemon's (`PROJECT_ICON_KEYS`). */
export const PROJECT_ICONS: Record<ProjectIconKey, LucideIcon> = {
	folder: Folder,
	code: Code,
	terminal: Terminal,
	server: Server,
	database: Database,
	globe: Globe,
	cpu: Cpu,
	flask: FlaskConical,
	book: BookOpen,
	music: Music,
	gamepad: Gamepad2,
	rocket: Rocket,
	wrench: Wrench,
	shield: Shield,
	chart: ChartColumn,
	cloud: Cloud,
	package: Package,
	layers: Layers,
	box: Box,
	cog: Cog,
	bug: Bug,
	brain: Brain,
	leaf: Leaf,
	star: Star,
	heart: Heart,
	home: House,
	camera: Camera,
	image: Image,
	film: Film,
	mail: Mail,
	chat: MessageSquare,
	key: Key,
	lock: Lock,
	map: MapIcon,
	compass: Compass,
	calendar: Calendar,
	clock: Clock,
	bolt: Zap,
	flag: Flag,
	tag: Tag,
	cart: ShoppingCart,
	wallet: Wallet,
	phone: Phone,
	palette: Palette,
};

export interface ProjectAppearance {
	icon?: string | null;
	color?: string | null;
}

/**
 * The one project avatar: a square tile with the project's chosen icon or text
 * mark on its chosen swatch, or (unset) a monogram of the name on a colour
 * derived from it. The rail, the expanded row, the project header, the
 * palette and the presence bar all draw this.
 */
export function ProjectAvatar({
	name,
	appearance,
	size = 28,
	className,
}: {
	name: string;
	appearance?: ProjectAppearance | null;
	/** Pixel edge of the square tile. */
	size?: number;
	className?: string;
}) {
	const a = resolveAvatar(name, appearance);
	const Icon =
		a.kind === "key" ? PROJECT_ICONS[a.value as ProjectIconKey] : null;
	return (
		<span
			aria-hidden
			data-testid="project-avatar"
			data-swatch={a.color}
			className={cn(
				"mfw-swatch inline-flex shrink-0 items-center justify-center font-semibold select-none",
				className,
			)}
			style={{
				width: size,
				height: size,
				borderRadius: "var(--mfw-radius-md)",
				fontSize: Math.max(9, Math.round(size * 0.4)),
				lineHeight: 1,
			}}
		>
			{Icon ? (
				<Icon aria-hidden style={{ width: size * 0.55, height: size * 0.55 }} />
			) : (
				<span className="mfw-num">{a.value}</span>
			)}
		</span>
	);
}

/** Display options of every attached project, keyed by name (one `system.projects` read, shared). */
export function useProjectAppearances(): ReadonlyMap<
	string,
	ProjectAppearance
> {
	const trpc = useTRPC();
	const projects = useQuery({
		...trpc.system.projects.queryOptions(),
		staleTime: 5 * 60_000,
	});
	return useMemo(
		() =>
			new Map(
				(projects.data ?? []).map((p) => [
					p.name,
					{ icon: p.icon, color: p.color },
				]),
			),
		[projects.data],
	);
}

/** `<ProjectAvatar>` for a project name, looking its appearance up itself. */
export function ConnectedProjectAvatar({
	name,
	size,
	className,
}: {
	name: string;
	size?: number;
	className?: string;
}) {
	const all = useProjectAppearances();
	return (
		<ProjectAvatar
			name={name}
			appearance={all.get(name)}
			size={size}
			className={className}
		/>
	);
}
