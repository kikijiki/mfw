import { TipSelect } from "~/components/ui/tooltip";
import type { RouterOutputs } from "../../lib/trpc";
import { shortRef } from "./repoModel";

/**
 * A branch, remote branch or tag picker over `repo.refs`. `emptyLabel` adds a
 * first option for "no ref" (the working copy, or "none"). A value the list
 * does not know stays selectable, so a link to a deleted branch says so
 * instead of silently switching.
 */
export function RefPicker({
	value,
	refs,
	onChange,
	emptyLabel,
	label,
	title,
	includeRemotes = true,
	includeTags = true,
}: {
	value: string | undefined;
	refs: RouterOutputs["repo"]["refs"] | undefined;
	onChange: (ref: string | undefined) => void;
	emptyLabel?: string;
	label: string;
	title?: string;
	includeRemotes?: boolean;
	includeTags?: boolean;
}) {
	const known = new Set([
		...(refs?.branches.map((b) => b.name) ?? []),
		...(refs?.tags.map((t) => t.name) ?? []),
	]);
	const locals = refs?.branches.filter((b) => b.kind === "local") ?? [];
	const remotes = refs?.branches.filter((b) => b.kind === "remote") ?? [];
	return (
		<TipSelect
			aria-label={label}
			tip={title}
			className="mfw-focus mfw-num min-h-7 max-w-64 border px-1.5"
			style={{
				background: "var(--mfw-bg-raised)",
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
				color: "var(--mfw-fg)",
				fontSize: "var(--mfw-text-xs)",
			}}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
		>
			{emptyLabel ? <option value="">{emptyLabel}</option> : null}
			{value && !known.has(value) ? (
				<option value={value}>{shortRef(value)}</option>
			) : null}
			<optgroup label="Local branches">
				{locals.map((b) => (
					<option key={`l:${b.name}`} value={b.name}>
						{shortRef(b.name)}
					</option>
				))}
			</optgroup>
			{includeRemotes && remotes.length > 0 ? (
				<optgroup label="Remote branches">
					{remotes.map((b) => (
						<option key={`r:${b.name}`} value={b.name}>
							{b.name}
						</option>
					))}
				</optgroup>
			) : null}
			{includeTags && refs && refs.tags.length > 0 ? (
				<optgroup label="Tags">
					{refs.tags.map((t) => (
						<option key={`t:${t.name}`} value={t.name}>
							{t.name}
						</option>
					))}
				</optgroup>
			) : null}
		</TipSelect>
	);
}
