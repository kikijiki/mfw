import { useQuery } from "@tanstack/react-query";
import { TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Mono } from "../../components/Cost";
import { useOpenTaskFromBoard } from "../../lib/nav";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

/**
 * Unordered tasks whose `owns` overlap. The scheduler already runs them one
 * after the other; this only says so, so a person can add a dependency or
 * narrow a claim. Dismissal lasts for the browser session and is keyed by the
 * exact set of pairs, so a new overlap shows the strip again.
 */

const KEY_PREFIX = "mfw:v2:board:ownership-dismissed:";

function readDismissed(project: string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage.getItem(KEY_PREFIX + project);
	} catch {
		return null;
	}
}

function writeDismissed(project: string, signature: string): void {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(KEY_PREFIX + project, signature);
	} catch {
		// storage blocked: the dismissal just lasts until the next render cycle
	}
}

export function OwnershipConflictNotice({ project }: { project: string }) {
	const trpc = useTRPC();
	const openTask = useOpenTaskFromBoard(project);
	const conflicts = useQuery(
		trpc.tasks.ownershipConflicts.queryOptions({ project }),
	);
	// SSR-safe: read session storage after mount.
	const [dismissed, setDismissed] = useState<string | null>(null);
	useEffect(() => setDismissed(readDismissed(project)), [project]);

	const pairs = conflicts.data ?? [];
	if (pairs.length === 0) return null;
	const signature = pairs.map((c) => `${c.a}:${c.b}`).join(",");
	if (dismissed === signature) return null;

	const taskLink = (id: string) => (
		<AppLink to={href.task(project, id)} navigate={() => openTask(id)}>
			<Mono value={id} />
		</AppLink>
	);

	return (
		<div
			role="status"
			className="flex items-start gap-2 border-b px-3 py-1.5"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-bg-subtle)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			<TriangleAlert
				aria-hidden
				className="mt-0.5 size-4 shrink-0"
				style={{ color: "var(--mfw-warn)" }}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span>
					{pairs.length === 1
						? "Two tasks claim the same files."
						: `${pairs.length} pairs of tasks claim the same files.`}
					<span style={{ color: "var(--mfw-fg-muted)" }}>
						{" "}
						They will run one after the other unless a dependency orders them.
					</span>
				</span>
				<ul className="flex flex-col gap-0.5">
					{pairs.map((c) => (
						<li key={`${c.a}:${c.b}`} className="min-w-0 break-words">
							{taskLink(c.a)} and {taskLink(c.b)}
							<span style={{ color: "var(--mfw-fg-muted)" }}>
								{" "}
								(
								{c.patterns
									.map(([pa, pb]) => (pa === pb ? pa : `${pa} / ${pb}`))
									.join(", ")}
								)
							</span>
						</li>
					))}
				</ul>
			</div>
			<Button
				size="xs"
				variant="ghost"
				aria-label="Dismiss ownership notice"
				onClick={() => {
					writeDismissed(project, signature);
					setDismissed(signature);
				}}
			>
				<X aria-hidden />
			</Button>
		</div>
	);
}
