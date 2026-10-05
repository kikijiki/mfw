import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Route as RouteIcon } from "lucide-react";
import { AppLink } from "~/components/AppLink";
import { Empty } from "~/components/Empty";
import { ErrorState } from "~/components/ErrorState";
import {
	LiveMetricChart,
	type LiveMetricSample,
	useRollingMetricSamples,
} from "~/components/LiveMetricChart";
import { LoadingRows } from "~/components/Loading";
import {
	Chip,
	Field,
	Page,
	PageHeader,
	Panel,
	Scroller,
} from "~/components/Page";
import { Button } from "~/components/ui/button";
import { useToast } from "~/lib/toast";
import type { RouterOutputs } from "~/lib/trpc";
import { useTRPC } from "~/lib/trpc";
import { href } from "~/routes";

type Model = RouterOutputs["openrouter"]["get"];
const AUTO_REFRESH_MS = 15_000;

function money(value: number | null): string {
	return value === null ? "-" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function integer(value: number): string {
	return Intl.NumberFormat().format(Math.round(value));
}

function when(value: number | null): string {
	return value === null ? "never" : new Date(value).toLocaleString();
}

function managementHint() {
	return "Add a separate management key in Settings to see account-wide model, provider, request, token, and spending activity.";
}

export function OpenRouterGlobalPage() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const account = useQuery({
		...trpc.openrouter.get.queryOptions(),
		refetchInterval: AUTO_REFRESH_MS,
		refetchIntervalInBackground: true,
	});
	const refresh = useMutation(
		trpc.openrouter.refresh.mutationOptions({
			meta: { label: "Refresh OpenRouter usage" },
			onSuccess: (model) => {
				queryClient.setQueryData(trpc.openrouter.get.queryKey(), model);
				toast({ tone: "success", title: "OpenRouter usage refreshed" });
			},
		}),
	);
	const model = account.data;
	const connected = Boolean(
		model?.credential.ready || model?.managementCredential.ready,
	);

	return (
		<Page className="h-full">
			<PageHeader
				title="OpenRouter"
				meta={
					model ? (
						<>
							<Chip tone={model.fresh ? "ok" : "warn"}>
								{model.fresh ? "live" : "stale"}
							</Chip>
							<Chip tone={model.credits.available ? "ok" : "warn"}>
								credits {money(model.credits.remainingCredits)}
							</Chip>
							<Chip tone={model.managementCredential.ready ? "ok" : "neutral"}>
								analytics{" "}
								{model.managementCredential.ready ? "connected" : "not set"}
							</Chip>
							<span>
								auto-refresh every 15s · last confirmed {when(model.observedAt)}
							</span>
						</>
					) : (
						"Live usage, credits, models, providers, and token volume"
					)
				}
				actions={
					<Button
						size="sm"
						variant="outline"
						disabled={refresh.isPending || !connected}
						onClick={() => refresh.mutate()}
					>
						<RefreshCw aria-hidden />{" "}
						{refresh.isPending ? "Refreshing…" : "Refresh usage"}
					</Button>
				}
			/>
			<Scroller className="flex flex-col gap-3 p-3">
				{account.isPending ? <LoadingRows rows={8} /> : null}
				{account.error ? (
					<ErrorState
						error={account.error}
						onRetry={() => void account.refetch()}
					/>
				) : null}
				{model && !connected ? (
					<Empty
						icon={RouteIcon}
						title="Connect OpenRouter"
						description="Store an API key in Settings to see machine-wide OpenRouter usage."
						action={
							<AppLink to={`${href.settings()}?tab=openrouter`}>
								Open OpenRouter settings
							</AppLink>
						}
					/>
				) : null}
				{model && connected ? (
					<OpenRouterDashboard
						model={model}
						sampledAt={account.dataUpdatedAt}
					/>
				) : null}
			</Scroller>
		</Page>
	);
}

function OpenRouterDashboard({
	model,
	sampledAt,
}: {
	model: Model;
	sampledAt: number;
}) {
	const key = model.key;
	const usage = model.accountUsage.available
		? {
				daily: model.accountUsage.daily,
				weekly: model.accountUsage.weekly,
				monthly: model.accountUsage.monthly,
			}
		: {
				daily: key?.usageDaily ?? null,
				weekly: key?.usageWeekly ?? null,
				monthly: key?.usageMonthly ?? null,
			};
	const liveSamples = useRollingMetricSamples(
		usage.daily !== null
			? {
					at: sampledAt,
					values: {
						daily: usage.daily,
						weekly: usage.weekly,
						monthly: usage.monthly,
					},
				}
			: null,
		120,
	);
	const history: LiveMetricSample[] = model.activity.days.map((day) => ({
		at: Date.parse(`${day.date}T00:00:00Z`),
		values: { usage: day.usage, byok: day.byokUsage, requests: day.requests },
	}));

	return (
		<>
			{model.error ? (
				<div
					role="alert"
					className="border p-3"
					style={{ borderColor: "var(--mfw-critical)" }}
				>
					The latest OpenRouter check failed. Last confirmed values are shown
					where available.
				</div>
			) : null}
			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				<Panel title="Today">
					<div className="text-2xl font-semibold mfw-num">
						{money(usage.daily)}
					</div>
				</Panel>
				<Panel title="This week">
					<div className="text-2xl font-semibold mfw-num">
						{money(usage.weekly)}
					</div>
				</Panel>
				<Panel title="This month">
					<div className="text-2xl font-semibold mfw-num">
						{money(usage.monthly)}
					</div>
				</Panel>
				<Panel title="Account credits left">
					<div className="text-2xl font-semibold mfw-num">
						{money(model.credits.remainingCredits)}
					</div>
					{!model.credits.available ? (
						<div
							className="mt-1 text-xs"
							style={{ color: "var(--mfw-fg-muted)" }}
						>
							Latest balance check unavailable
						</div>
					) : null}
				</Panel>
			</div>
			<Panel
				title={
					model.accountUsage.available
						? "Live account usage"
						: "Live inference-key usage"
				}
			>
				<LiveMetricChart
					label={
						model.accountUsage.available
							? "OpenRouter account usage"
							: "OpenRouter inference key usage"
					}
					samples={liveSamples}
					series={[
						{ key: "daily", label: "today" },
						{ key: "weekly", label: "week" },
						{ key: "monthly", label: "month" },
					]}
					formatValue={(value) => money(value)}
				/>
				<p className="mt-2 text-xs" style={{ color: "var(--mfw-fg-muted)" }}>
					{model.accountUsage.available
						? `Totals across ${integer(model.accountUsage.keyCount)} account keys. `
						: "Totals for the configured inference key. "}
					Rolling samples are collected while this page is open. MFW checks
					OpenRouter automatically every 15 seconds.
				</p>
			</Panel>
			<div className="grid gap-3 lg:grid-cols-2">
				<Panel title="Key and account">
					<Field label="Key">{key?.label ?? "label not reported"}</Field>
					<Field label="Total key usage">{money(key?.usage ?? null)}</Field>
					<Field label="Provider key limit">{money(key?.limit ?? null)}</Field>
					<Field label="Limit resets">
						{key?.limitReset ?? "no reset configured"}
					</Field>
					<Field label="Expires">
						{key?.expiresAt
							? new Date(key.expiresAt).toLocaleString()
							: "does not expire"}
					</Field>
					<Field label="Last confirmed">{when(model.observedAt)}</Field>
				</Panel>
				<Panel title="Credits">
					{model.credits.available ? (
						<>
							<Field label="Purchased credits">
								{money(model.credits.totalCredits)}
							</Field>
							<Field label="Total account usage">
								{money(model.credits.totalUsage)}
							</Field>
							<Field label="Credits left">
								{money(model.credits.remainingCredits)}
							</Field>
						</>
					) : (
						<p style={{ color: "var(--mfw-fg-muted)" }}>
							Credits are temporarily unavailable. MFW will retry automatically.
						</p>
					)}
				</Panel>
			</div>
			{model.activity.available ? (
				<>
					<Panel title="Daily activity: last 30 completed UTC days">
						<LiveMetricChart
							label="OpenRouter daily spend"
							samples={history}
							series={[
								{ key: "usage", label: "OpenRouter spend" },
								{ key: "byok", label: "BYOK inference" },
							]}
							formatValue={(value) => money(value)}
							sampleScope="provider-reported completed UTC days"
						/>
					</Panel>
					<div className="grid gap-3 lg:grid-cols-2">
						<UsageTable title="Models" rows={model.activity.models} />
						<UsageTable title="Providers" rows={model.activity.providers} />
					</div>
				</>
			) : (
				<Panel title="Model and provider activity">
					<p style={{ color: "var(--mfw-fg-muted)" }}>
						{model.activity.reason === "management_key_required"
							? managementHint()
							: "Activity is temporarily unavailable."}
					</p>
				</Panel>
			)}
		</>
	);
}

function UsageTable({
	title,
	rows,
}: {
	title: string;
	rows: Model["activity"]["models"];
}) {
	return (
		<Panel title={title} pad={false}>
			<div className="divide-y" style={{ borderColor: "var(--mfw-border)" }}>
				{rows.slice(0, 10).map((row) => (
					<div
						key={row.name}
						className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2"
					>
						<div className="min-w-0 truncate" title={row.name}>
							{row.name}
						</div>
						<div className="text-right mfw-num">
							<div>{money(row.usage)}</div>
							<div className="text-xs" style={{ color: "var(--mfw-fg-muted)" }}>
								{integer(row.requests)} req · {integer(row.tokens)} tokens
							</div>
						</div>
					</div>
				))}
			</div>
		</Panel>
	);
}
