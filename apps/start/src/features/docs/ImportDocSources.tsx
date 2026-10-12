import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Checkbox } from "~/components/ui/checkbox";
import { useTRPC } from "../../lib/trpc";

/**
 * "Import from repo" also finds where the repository keeps its documentation.
 * Each conventional location (docs/, architecture/, README.md and friends) is
 * listed with a box; the ticked ones are recorded as Docs sources when the
 * import starts (`runs.startImport({ docSources })`). Nothing is recorded for
 * a box the person unticks, and a repository with none shows nothing here.
 */
export function useDocImportChoice(project: string, enabled: boolean) {
	const trpc = useTRPC();
	const suggestions = useQuery({
		...trpc.docs.suggestions.queryOptions({ project }),
		enabled,
	});
	const [unticked, setUnticked] = useState<Set<string>>(new Set());
	const found = suggestions.data ?? [];
	return {
		found,
		isChosen: (id: string) => !unticked.has(id),
		toggle: (id: string) =>
			setUnticked((cur) => {
				const next = new Set(cur);
				if (!next.delete(id)) next.add(id);
				return next;
			}),
		/** What to send as `docSources`. */
		chosen: found.filter((s) => !unticked.has(s.id)).map((s) => s.id),
	};
}

export function ImportDocSources({
	choice,
}: {
	choice: ReturnType<typeof useDocImportChoice>;
}) {
	if (choice.found.length === 0) return null;
	return (
		<fieldset className="flex flex-col gap-1.5">
			<legend
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				Documentation found. Ticked ones are added to this project's Docs.
			</legend>
			{choice.found.map((s) => (
				<label
					key={s.id}
					htmlFor={`docsrc-${s.id}`}
					className="flex items-center gap-2"
				>
					<Checkbox
						id={`docsrc-${s.id}`}
						checked={choice.isChosen(s.id)}
						onCheckedChange={() => choice.toggle(s.id)}
						aria-label={`List ${s.label} in Docs`}
					/>
					<span className="min-w-0 flex-1 truncate">
						<span className="font-medium">{s.label}</span>{" "}
						<span
							style={{
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{s.reason}
						</span>
					</span>
				</label>
			))}
		</fieldset>
	);
}
