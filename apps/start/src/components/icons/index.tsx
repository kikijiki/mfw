import { cn } from "~/lib/utils";
import { TipSpan } from "../ui/tooltip";
import { glyphOf } from "./glyphs";
import { type IconLook, priorityLook, statusLook, taskTypeLook } from "./looks";

export * from "./glyphs";
export * from "./looks";

/**
 * A registry mark (`GLYPHS` key) as an inline SVG: monochrome
 * (`currentColor`), sized to the text it sits in (`size-3.5` by default),
 * `aria-hidden` unless it carries a `label` of its own (then it is a
 * labelled image). Colour comes from the parent or from `token`.
 */
export function Glyph({
	name,
	label,
	token,
	className,
	bold,
}: {
	name: string;
	/** Heavier stroke, for marks that ask for a person. */
	bold?: boolean;
	label?: string;
	/** A tokens.css custom property name; omitted = inherit the text colour. */
	token?: string;
	/** Size/layout classes; defaults to `size-3.5`. */
	className?: string;
}) {
	const { icon: Icon, solid } = glyphOf(name);
	return (
		<Icon
			data-glyph={name}
			{...(label
				? { role: "img", "aria-label": label }
				: { "aria-hidden": true })}
			fill={solid ? "currentColor" : "none"}
			strokeWidth={bold ? 2.75 : 2}
			className={cn("shrink-0", className ?? "size-3.5")}
			style={token ? { color: `var(${token})` } : undefined}
		/>
	);
}

function Mark({
	look,
	label,
	showLabel,
	className,
}: {
	look: IconLook;
	label?: string;
	showLabel: boolean;
	className?: string;
}) {
	const Icon = look.icon;
	const text = label ?? look.label;
	return (
		<TipSpan
			role="img"
			aria-label={text}
			tip={showLabel ? undefined : text}
			className={cn("inline-flex shrink-0 items-center gap-1", className)}
			style={{ color: `var(${look.token})` }}
		>
			<Icon aria-hidden className={cn("size-3.5")} />
			{showLabel ? (
				<span style={{ fontSize: "var(--mfw-text-2xs)" }}>{text}</span>
			) : null}
		</TipSpan>
	);
}

/**
 * A board status as icon + accessible label. Pass the `role` `board.schema`
 * gave the status (so custom statuses draw correctly) and, for the label, the
 * board's own `label`.
 */
export function StatusIcon({
	statusRole,
	value,
	label,
	showLabel = false,
	className,
}: {
	statusRole: string | null | undefined;
	/** The board's own status value (fallback seed when the role is unknown). */
	value?: string;
	/** Overrides the default label, e.g. the board's `Doing`. */
	label?: string;
	showLabel?: boolean;
	className?: string;
}) {
	const look = statusLook(statusRole, value);
	return (
		<Mark
			look={look}
			label={label}
			showLabel={showLabel}
			className={className}
		/>
	);
}

/** A task type as icon + accessible label; unknown types get a stable fallback. */
export function TaskTypeIcon({
	type,
	showLabel = false,
	className,
}: {
	type: string | null | undefined;
	showLabel?: boolean;
	className?: string;
}) {
	return (
		<Mark
			look={taskTypeLook(type)}
			showLabel={showLabel}
			className={className}
		/>
	);
}

/** A task priority as an icon with its label in the tooltip; nothing for an unknown one. */
export function PriorityIcon({
	priority,
	className,
}: {
	priority: string | null | undefined;
	className?: string;
}) {
	const look = priorityLook(priority);
	if (!look) return null;
	return <Mark look={look} showLabel={false} className={className} />;
}
