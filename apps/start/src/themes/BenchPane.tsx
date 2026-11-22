import { useQuery } from "@tanstack/react-query";

import { NeedsQueue } from "../features/home/NeedsQueue";
import { useTRPC } from "../lib/trpc";
import { usePaintedTheme } from "./useThemeName";

/**
 * The Bench theme's right pane: the needs queue beside whatever is open.
 * Mounted only while Bench is painted, so no other theme pays for it. It reads
 * the same `inbox.list` and `runs.active` caches as Home.
 */
export function BenchPane() {
	return usePaintedTheme() === "bench" ? <Pane /> : null;
}

function Pane() {
	const trpc = useTRPC();
	const inbox = useQuery(trpc.inbox.list.queryOptions());
	const active = useQuery(trpc.runs.active.queryOptions());
	const items = inbox.data?.items ?? [];
	return (
		<aside aria-label="Needs you, all projects" data-ui="bench-pane">
			<div data-ui="bench-pane-title">
				<span>Needs you</span>
				<span className="mfw-num">{items.length}</span>
			</div>
			<div data-ui="bench-pane-body">
				<NeedsQueue items={items} runs={active.data} grouped />
			</div>
		</aside>
	);
}
