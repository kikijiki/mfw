import { Chip } from "~/components/Page";
import { cn } from "~/lib/utils";

import type { BoardTemplateInfo } from "./addProject";

/** One card per board template: its statuses are the columns the board will have. */
export function TemplateCards({
	templates,
	value,
	onChange,
}: {
	templates: readonly BoardTemplateInfo[];
	value: string;
	onChange: (id: string) => void;
}) {
	return (
		<fieldset aria-label="Board template" className="grid gap-2">
			{templates.map((template) => {
				const active = template.id === value;
				return (
					<button
						key={template.id}
						type="button"
						aria-pressed={active}
						className={cn(
							"mfw-focus flex min-h-11 flex-col items-start gap-1 border p-2 text-left",
						)}
						style={{
							borderRadius: "var(--mfw-radius-sm)",
							borderColor: active ? "var(--mfw-accent)" : "var(--mfw-border)",
							background: active ? "var(--mfw-accent-subtle)" : "transparent",
						}}
						onClick={() => onChange(template.id)}
					>
						<span className="font-medium">{template.title}</span>
						<span
							style={{
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{template.description}
						</span>
						<span className="flex flex-wrap gap-1">
							{template.statuses.map((status, index) => (
								<Chip key={status} tone={active ? "accent" : "neutral"}>
									{index + 1}. {status}
								</Chip>
							))}
						</span>
					</button>
				);
			})}
		</fieldset>
	);
}
