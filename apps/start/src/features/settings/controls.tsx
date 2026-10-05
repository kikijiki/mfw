import type { ReactNode } from "react";
import { HelpTip } from "../../components/HelpTip";
import { Chip } from "../../components/Page";

/** Form widgets shared by the settings panels. Kept out of `components/` since nothing else edits config values. */

/** "Saved now, but the daemon reads it at attach time." A permanent property of the field (`SettingsService.RESTART_KEYS`), not a post-save badge. */
export function RestartMark() {
	return (
		<span className="inline-flex items-center gap-0.5">
			<Chip tone="warn">restart required</Chip>
			<HelpTip label="About restart-required settings">
				Your change is saved now and takes effect after MFW restarts.
			</HelpTip>
		</span>
	);
}

/** A labelled control. `restart` comes from the server's `needsRestart`. */
export function Setting({
	label,
	hint,
	restart = false,
	children,
}: {
	label: string;
	hint?: ReactNode;
	restart?: boolean;
	children: ReactNode;
}) {
	return (
		// A <div>, not a <label>: call sites carry their own `aria-label`; an implicit label would add a competing name.
		<div className="flex min-w-0 flex-col gap-1">
			<span className="flex flex-wrap items-center gap-1.5">
				<span
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{label}
				</span>
				{hint ? <HelpTip label={`About ${label}`}>{hint}</HelpTip> : null}
				{restart ? <RestartMark /> : null}
			</span>
			{children}
		</div>
	);
}

/** A checkbox with its label on the right, and the same restart marker. */
export function Toggle({
	label,
	hint,
	restart = false,
	checked,
	disabled = false,
	onChange,
}: {
	label: string;
	hint?: ReactNode;
	restart?: boolean;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-1.5">
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={checked}
						disabled={disabled}
						onChange={(e) => onChange(e.target.checked)}
					/>
					<span>{label}</span>
				</label>
				{hint ? <HelpTip label={`About ${label}`}>{hint}</HelpTip> : null}
				{restart ? <RestartMark /> : null}
			</div>
		</div>
	);
}

/** Hand-styled native `<select>` (see `TaskPage`'s `Choice`); native so it works correctly on phones. */
export function Select({
	value,
	options,
	ariaLabel,
	className,
	onChange,
}: {
	value: string;
	options: readonly string[];
	ariaLabel?: string;
	className?: string;
	onChange: (value: string) => void;
}) {
	return (
		<select
			aria-label={ariaLabel}
			className={`mfw-focus min-h-8 border px-1.5 ${className ?? ""}`}
			style={{
				background: "var(--mfw-bg-raised)",
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
				color: "var(--mfw-fg)",
			}}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		>
			{options.map((option) => (
				<option key={option} value={option}>
					{option}
				</option>
			))}
		</select>
	);
}

/** Segmented radio group: for two or three mutually exclusive words. */
export function Segmented({
	value,
	options,
	label,
	onChange,
}: {
	value: string;
	options: readonly string[];
	label: string;
	onChange: (value: string) => void;
}) {
	return (
		<fieldset
			className="m-0 inline-flex min-w-0 flex-wrap gap-1 border-0 p-0"
			aria-label={label}
		>
			{options.map((option) => {
				const active = option === value;
				return (
					<button
						key={option}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option)}
						className="mfw-focus min-h-8 border px-2 capitalize"
						style={{
							borderColor: active ? "var(--mfw-accent)" : "var(--mfw-border)",
							background: active ? "var(--mfw-accent-subtle)" : "transparent",
							color: active ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
							borderRadius: "var(--mfw-radius-sm)",
						}}
					>
						{option === "runpod"
							? "RunPod"
							: option === "openrouter"
								? "OpenRouter"
								: option}
					</button>
				);
			})}
		</fieldset>
	);
}
