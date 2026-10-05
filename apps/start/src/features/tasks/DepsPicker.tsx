import { X } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Input } from "~/components/ui/input";
import { AppLink } from "../../components/AppLink";
import { StatusPill } from "../../components/StatusPill";
import type { RouterOutputs } from "../../lib/trpc";
import { href } from "../../routes";

/**
 * Dependency picker: autocomplete over the project's tasks, chips that link to
 * their target and show its status.
 *
 * A dependency is the highest-leverage field on a task, it is what stops the
 * scheduler dispatching work whose prerequisites are unfinished: and v1 asked
 * the operator to type ids into a YAML array by hand.
 */
export function DepsPicker({
	project,
	value,
	options,
	selfId,
	onChange,
	error,
}: {
	project: string;
	value: string[];
	options: RouterOutputs["tasks"]["list"];
	selfId: string;
	onChange: (next: string[]) => void;
	/** Server-side rejection (a cycle) belongs under the field, not in a toast. */
	error?: string | null;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const byId = useMemo(() => new Map(options.map((t) => [t.id, t])), [options]);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return options
			.filter(
				(t) =>
					t.id !== selfId &&
					!value.includes(t.id) &&
					`${t.id} ${t.title}`.toLowerCase().includes(q),
			)
			.slice(0, 8);
	}, [options, query, selfId, value]);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				{value.map((id) => {
					const dep = byId.get(id);
					return (
						<span
							key={id}
							className="inline-flex max-w-full min-w-0 items-center gap-1 border px-1.5 py-0.5"
							style={{
								borderColor: "var(--mfw-border)",
								borderRadius: "var(--mfw-radius-sm)",
								background: "var(--mfw-bg-subtle)",
							}}
						>
							{dep ? (
								<StatusPill kind="task" value={dep.status} variant="dot" />
							) : null}
							<AppLink
								to={href.task(project, id)}
								className="mfw-num max-w-32 shrink-0 truncate"
							>
								{id}
							</AppLink>
							{dep ? (
								<span
									className="min-w-0 max-w-40 flex-1 truncate"
									style={{
										color: "var(--mfw-fg-muted)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									{dep.title}
								</span>
							) : (
								<span style={{ color: "var(--mfw-warn)" }}>unknown</span>
							)}
							<button
								type="button"
								aria-label={`Remove dependency ${id}`}
								className="mfw-focus"
								style={{ color: "var(--mfw-fg-faint)" }}
								onClick={() => onChange(value.filter((v) => v !== id))}
							>
								<X aria-hidden className="size-3" />
							</button>
						</span>
					);
				})}
			</div>

			<div className="relative max-w-100">
				<Input
					value={query}
					placeholder="Add a dependency (id or title)"
					aria-label="Add a dependency"
					aria-controls={listId}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						const first = matches[0];
						if (!first) return;
						onChange([...value, first.id]);
						setQuery("");
					}}
				/>
				{matches.length > 0 ? (
					<ul
						id={listId}
						className="absolute z-20 mt-1 max-h-60 w-full overflow-auto border"
						style={{
							background: "var(--mfw-bg-raised)",
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							boxShadow: "var(--mfw-shadow-overlay)",
						}}
					>
						{matches.map((task) => (
							<li key={task.id}>
								<button
									type="button"
									className="mfw-focus flex w-full items-center gap-2 px-2 py-1 text-left"
									onClick={() => {
										onChange([...value, task.id]);
										setQuery("");
									}}
								>
									<StatusPill kind="task" value={task.status} variant="dot" />
									<span className="mfw-num max-w-32 shrink-0 truncate">
										{task.id}
									</span>
									<span className="min-w-0 flex-1 truncate">{task.title}</span>
								</button>
							</li>
						))}
					</ul>
				) : null}
			</div>

			{error ? (
				<p className="break-words" style={{ color: "var(--mfw-critical)" }}>
					{error}
				</p>
			) : null}
		</div>
	);
}
