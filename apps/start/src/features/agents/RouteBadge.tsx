import { TipSpan } from "~/components/ui/tooltip";
import { Chip } from "../../components/Page";

/** A run's routing decision as the API summarizes it (`runs.get` / `runs.active`). */
export interface RunRoute {
	key: string;
	reason: string;
	detail: string;
	endpoint: string | null;
	/** Registry SSH host the run executed on; absent/null = this machine or RunPod. */
	hostId?: string | null;
}

const REASON_LABEL: Record<string, string> = {
	explicit: "picked by hand",
	brain: "chosen by the brain",
	task: "task pin",
	"project-tier": "project tier",
	"project-model-standard": "project model",
	"project-model": "project default",
	"catalogue-tier": "catalogue tier",
	"provider-default": "provider default",
	inherited: "inherited",
	escalated: "escalated",
	fallback: "fallback",
};

/** Where a run executed when it was not this machine: the SSH host chip. */
export function HostChip({ hostId }: { hostId?: string | null }) {
	if (!hostId) return null;
	return <Chip tone="info">ssh:{hostId}</Chip>;
}

/**
 * Provider (harness, or `harness@endpoint`) + why it was chosen, and the SSH
 * host when it ran on one. Falls back to the bare provider id for runs
 * recorded before routing existed.
 */
export function RouteBadge({
	route,
	providerId,
}: {
	route?: RunRoute | null;
	providerId: string | null;
}) {
	if (!route) return providerId ? <Chip>{providerId}</Chip> : null;
	const tone =
		route.reason === "fallback" || route.reason === "escalated"
			? "warn"
			: route.endpoint
				? "info"
				: "neutral";
	return (
		<>
			<Chip tone={tone} title={route.detail}>
				{route.key}
			</Chip>
			<TipSpan tip={route.detail}>
				{REASON_LABEL[route.reason] ?? route.reason}
			</TipSpan>
			<HostChip hostId={route.hostId} />
		</>
	);
}
