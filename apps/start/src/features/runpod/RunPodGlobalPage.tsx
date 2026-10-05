import type { AppRouter } from "@mfw/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TRPCClientErrorLike } from "@trpc/client";
import {
	ChevronDown,
	ChevronRight,
	Cloud,
	Pause,
	Play,
	RefreshCw,
	ShieldAlert,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppLink } from "~/components/AppLink";
import { ConfirmDialog } from "~/components/ConfirmDialog";
import { Empty } from "~/components/Empty";
import { ErrorState } from "~/components/ErrorState";
import {
	LiveMetricChart,
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
import {
	runPodComputeText,
	runPodDispatchStatus,
	runPodErrorText,
	runPodPhaseText,
	runPodResumeDisabledReason,
	runPodTerminationDisabledReason,
} from "./runpodPresentation";

type Model = RouterOutputs["runpod"]["get"];
type Pod = Model["pods"][number];
type ApiError = TRPCClientErrorLike<AppRouter>;
const AUDIT_ACTOR = "local-operator";

function money(value: number | null): string {
	return value === null ? "unknown" : `$${value.toFixed(4)}`;
}

function remainingCredit(balance: Model["balance"]): string {
	if (balance.remainingCredits !== null)
		return `$${balance.remainingCredits.toFixed(2)} ${balance.currency}`;
	return "No confirmed balance yet";
}

function when(value: number | null): string {
	return value === null ? "never" : new Date(value).toLocaleString();
}

function ownershipLabel(ownership: Pod["ownership"]): string {
	if (ownership.startsWith("owned_")) return "MFW created this Pod";
	if (ownership === "foreign_account") return "Created outside MFW";
	return "Ownership unknown";
}

export function RunPodGlobalPage() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const account = useQuery({
		...trpc.runpod.get.queryOptions(),
		// The account reconciler is process-global and may change without a project
		// event. Keep this safety view live even when no project is attached.
		refetchInterval: 15_000,
	});
	const [auditOpen, setAuditOpen] = useState(false);
	const [cleanupPod, setCleanupPod] = useState<Pod | null>(null);
	const [conflict, setConflict] = useState<string | null>(null);
	const invalidate = async () => {
		await queryClient.invalidateQueries(trpc.runpod.get.queryFilter());
	};
	const mutationError = (error: ApiError): boolean => {
		if (error.data?.code === "CONFLICT") {
			setConflict(
				"RunPod dispatch changed before this action landed. The latest state is loading; review it before retrying.",
			);
			return true;
		}
		return false;
	};
	const refresh = useMutation(
		trpc.runpod.refresh.mutationOptions({
			meta: { label: "Refresh RunPod account" },
			onSuccess: () =>
				toast({ tone: "success", title: "RunPod account refreshed" }),
			onSettled: invalidate,
		}),
	);
	const pause = useMutation(
		trpc.runpod.setPaused.mutationOptions({
			meta: { label: "Change RunPod dispatch pause" },
			onError: mutationError,
			onSuccess: (updated) => {
				queryClient.setQueryData(trpc.runpod.get.queryKey(), updated);
			},
			onSettled: invalidate,
		}),
	);
	const cleanup = useMutation(
		trpc.runpod.cleanup.mutationOptions({
			meta: { label: "Terminate owned RunPod Pod" },
			onSuccess: () => {
				setCleanupPod(null);
				toast({
					tone: "success",
					title: "Pod terminated and no longer present",
				});
			},
			onSettled: invalidate,
		}),
	);
	const model = account.data;
	const resumeDisabledReason =
		model?.settings.dispatchPaused === true
			? runPodResumeDisabledReason({
					enabled: model.enabled,
					credentialReady: model.credential.ready,
					credentialValidated: Boolean(
						model.credential.validatedAt && !model.credential.validationError,
					),
					inventoryFresh: model.inventory.fresh,
					reconcileError: model.reconcile.lastError,
				})
			: null;

	return (
		<Page className="h-full">
			<PageHeader
				title="RunPod"
				meta={
					model ? (
						<>
							<Chip tone={model.gate.open ? "ok" : "critical"}>
								dispatch {model.gate.open ? "open" : "closed"}
							</Chip>
							<Chip tone={model.inventory.fresh ? "ok" : "warn"}>
								inventory {model.inventory.fresh ? "fresh" : "stale"}
							</Chip>
							<Chip tone={model.balance.fresh ? "ok" : "warn"}>
								credits {remainingCredit(model.balance)}
							</Chip>
						</>
					) : (
						"Live Pods, spend, account checks, and cleanup"
					)
				}
				actions={
					<div className="flex flex-col items-end gap-1">
						<Button
							size="sm"
							variant="outline"
							disabled={refresh.isPending || !model?.credential.ready}
							onClick={() => refresh.mutate({ reason: "operator refresh" })}
							title="Read the remaining RunPod credit and check every Pod against MFW's records"
						>
							<RefreshCw aria-hidden /> Check live account
						</Button>
						{model && !model.credential.ready ? (
							<span
								className="text-xs"
								style={{ color: "var(--mfw-fg-muted)" }}
							>
								Store account credentials in RunPod settings to check the
								account.
							</span>
						) : null}
					</div>
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
				{model ? (
					<>
						{conflict ? (
							<div
								role="alert"
								className="border p-3"
								style={{ borderColor: "var(--mfw-warn)" }}
							>
								{conflict}
							</div>
						) : null}
						{!model.gate.open ? (
							<div
								role="alert"
								className="flex items-center gap-2 border p-3"
								style={{ borderColor: "var(--mfw-critical)" }}
							>
								<ShieldAlert aria-hidden className="size-4" />
								<span>
									Remote dispatch is closed:{" "}
									{model.gate.reason ?? "no safe reason was reported"}
								</span>
								{!model.enabled || !model.credential.ready ? (
									<AppLink to={`${href.settings()}?tab=runpod`}>
										Open RunPod settings
									</AppLink>
								) : null}
							</div>
						) : null}

						<RunPodTelemetry model={model} sampledAt={account.dataUpdatedAt} />

						<div className="grid gap-3 lg:grid-cols-3">
							<Panel title="Account state">
								<Field label="Last confirmed balance">
									{remainingCredit(model.balance)}
								</Field>
								<Field label="Confirmed at">
									{when(model.balance.observedAt)}
								</Field>
								<Field label="Latest balance check">
									{model.balance.error
										? `Failed ${when(model.balance.checkedAt)}: ${runPodErrorText(model.balance.error)}`
										: model.balance.checkedAt
											? `Succeeded ${when(model.balance.checkedAt)}`
											: "Not checked yet"}
								</Field>
								<Field label="Balance source">
									RunPod account API, not estimated from spend
								</Field>
								<Field label="Credential">
									{model.credential.ready ? "available" : "missing"}
								</Field>
								<Field label="API validation">
									{model.credential.validatedAt
										? `passed ${when(model.credential.validatedAt)}`
										: (runPodErrorText(model.credential.validationError) ??
											"Not validated")}
								</Field>
								<Field label="Inventory">
									{when(model.inventory.observedAt)}
								</Field>
								<Field label="Last account check">
									{when(model.reconcile.lastAttemptAt)}
								</Field>
								{model.reconcile.lastError ? (
									<Field label="Latest account check failure">
										{runPodErrorText(model.reconcile.lastError)}
									</Field>
								) : null}
								<Field label="Pods awaiting cleanup">
									{model.reconcile.cleanupPending}
								</Field>
							</Panel>
							<Panel title={model.costs.providerInfrastructure.label}>
								<Field label="Nominal hourly">
									{money(model.costs.providerInfrastructure.costPerHr)}
								</Field>
								<Field label="Adjusted hourly">
									{money(model.costs.providerInfrastructure.adjustedCostPerHr)}
								</Field>
								<Field label="Safety burn">
									{money(model.costs.providerInfrastructure.hourlyBurn)}
								</Field>
								<Field label="Estimated total">
									{money(model.costs.providerInfrastructure.estimatedCost)}
								</Field>
							</Panel>
							<Panel title="Dispatch control">
								<Field label="Status">
									{runPodDispatchStatus({
										gateOpen: model.gate.open,
										requestedPaused: model.settings.dispatchPaused,
										gateReason: model.gate.reason,
									})}
								</Field>
								<Button
									className="mt-2 self-start"
									variant={
										model.settings.dispatchPaused ? "default" : "destructive"
									}
									disabled={pause.isPending || Boolean(resumeDisabledReason)}
									onClick={() =>
										pause.mutate({
											expectedVersion: model.settings.version,
											paused: !model.settings.dispatchPaused,
											actor: AUDIT_ACTOR,
										})
									}
								>
									{model.settings.dispatchPaused ? (
										<Play aria-hidden />
									) : (
										<Pause aria-hidden />
									)}
									{model.settings.dispatchPaused
										? "Resume after live check"
										: "Pause dispatch"}
								</Button>
								{resumeDisabledReason ? (
									<p
										className="mt-2 text-xs"
										style={{ color: "var(--mfw-fg-muted)" }}
									>
										{resumeDisabledReason}
									</p>
								) : null}
							</Panel>
						</div>

						<Panel
							title={`Provider inventory · ${model.pods.length}`}
							pad={false}
						>
							{model.pods.length === 0 ? (
								<Empty
									icon={Cloud}
									title="No RunPod Pods are visible"
									description={
										model.inventory.fresh
											? "The latest account check found no Pods."
											: "Check live inventory to see whether any Pods are running."
									}
								/>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-left">
										<thead>
											<tr
												className="border-b"
												style={{ borderColor: "var(--mfw-border)" }}
											>
												<th className="p-2">Pod</th>
												<th className="p-2">Ownership</th>
												<th className="p-2">Shape</th>
												<th className="p-2">Status</th>
												<th className="p-2">Burn</th>
												<th className="p-2">Action</th>
											</tr>
										</thead>
										<tbody>
											{model.pods.map((pod) => {
												const disabledReason = runPodTerminationDisabledReason({
													inventoryFresh: model.inventory.fresh,
													live: pod.live,
													owned: pod.ownership.startsWith("owned_"),
													hasFingerprint: Boolean(pod.ownershipFingerprint),
												});
												const mayDelete = disabledReason === null;
												return (
													<tr
														key={`${pod.podId}/${pod.leaseRef ?? "observed"}`}
														className="border-b"
														style={{ borderColor: "var(--mfw-border)" }}
													>
														<td className="p-2">
															<div>{pod.name || pod.podId}</div>
															<div
																className="mfw-num"
																style={{ color: "var(--mfw-fg-faint)" }}
															>
																{pod.podId}
															</div>
														</td>
														<td className="p-2">
															<Chip
																tone={
																	pod.ownership.startsWith("owned_")
																		? "ok"
																		: "warn"
																}
															>
																{ownershipLabel(pod.ownership)}
															</Chip>
															<div>
																{pod.projectName ??
																	pod.projectId ??
																	"not linked"}
															</div>
															<div className="mfw-num">
																{pod.projectName && pod.runId ? (
																	<AppLink
																		to={href.run(pod.projectName, pod.runId)}
																	>
																		{pod.runId}
																	</AppLink>
																) : (
																	(pod.runId ?? "-")
																)}
															</div>
														</td>
														<td className="p-2">
															{pod.actualShape.computeType ?? "unknown"} ·{" "}
															{pod.actualShape.offeringId ?? "unknown"}
															<div>
																{runPodComputeText(pod.actualShape)} ·{" "}
																{pod.actualShape.memoryInGb ?? "?"} GB
															</div>
														</td>
														<td className="p-2">
															{runPodPhaseText(pod.phase)}
															<details className="text-xs">
																<summary>Provider details</summary>
																<div>Status: {pod.desiredStatus}</div>
																<div>Machine phase: {pod.phase}</div>
															</details>
															{pod.cleanup.lastError ? (
																<div
																	className="mt-1 text-xs"
																	style={{ color: "var(--mfw-critical)" }}
																>
																	Latest lifecycle issue:{" "}
																	{runPodErrorText(pod.cleanup.lastError)}
																</div>
															) : null}
														</td>
														<td className="p-2 mfw-num">
															{money(pod.hourlyBurn)}/hr
															<div>
																{money(pod.estimatedInfrastructureCost)} est.
															</div>
														</td>
														<td className="p-2">
															<Button
																size="sm"
																variant="destructive"
																disabled={!mayDelete}
																title={
																	mayDelete
																		? "MFW created this Pod; terminate it and verify it is gone"
																		: (disabledReason ?? undefined)
																}
																onClick={() => setCleanupPod(pod)}
															>
																<Trash2 aria-hidden /> Terminate
															</Button>
															{disabledReason ? (
																<div
																	className="mt-1 text-xs"
																	style={{ color: "var(--mfw-fg-muted)" }}
																>
																	{disabledReason}
																</div>
															) : null}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							)}
						</Panel>

						<RunPodAuditPanel
							open={auditOpen}
							onOpenChange={setAuditOpen}
							entries={model.audit}
						/>
					</>
				) : null}
			</Scroller>

			<ConfirmDialog
				open={cleanupPod !== null}
				onOpenChange={(open) => {
					if (!open) {
						setCleanupPod(null);
					}
				}}
				title={`Terminate ${cleanupPod?.podId ?? "Pod"}`}
				description="MFW will check the live account again, confirm it created this Pod, terminate only this Pod, and verify that it is gone."
				confirmText={cleanupPod?.podId}
				confirmLabel="Terminate and verify"
				pending={cleanup.isPending}
				onConfirm={() => {
					if (
						!cleanupPod ||
						!model?.inventory.observedAt ||
						!cleanupPod.ownershipFingerprint
					)
						return;
					cleanup.mutate({
						podId: cleanupPod.podId,
						reason: "Operator terminated owned Pod from live inventory",
						actor: AUDIT_ACTOR,
						confirmed: true,
						expectedOwnershipFingerprint: cleanupPod.ownershipFingerprint,
						expectedObservedAt: model.inventory.observedAt,
					});
				}}
			/>
		</Page>
	);
}

function RunPodTelemetry({
	model,
	sampledAt,
}: {
	model: Model;
	sampledAt: number;
}) {
	const livePods = model.pods.filter((pod) => pod.live).length;
	const samples = useRollingMetricSamples({
		at: sampledAt,
		values: {
			balance: model.balance.remainingCredits,
			hourlyBurn: model.costs.providerInfrastructure.hourlyBurn,
			estimatedCost: model.costs.providerInfrastructure.estimatedCost,
			livePods,
		},
	});
	return (
		<Panel title="Live account telemetry">
			<p className="mb-3" style={{ color: "var(--mfw-fg-muted)" }}>
				Provider balance and inventory are reconciled from the live RunPod API.
				Cost is MFW's safety estimate. Charts retain only samples collected
				while this page is open.
			</p>
			<div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
				<RunPodMetric
					label="Remaining credits"
					value={remainingCredit(model.balance)}
					chart={
						<LiveMetricChart
							label="RunPod remaining credits"
							samples={samples}
							series={[{ key: "balance", label: "Balance" }]}
							formatValue={(value) => `$${value.toFixed(2)}`}
						/>
					}
				/>
				<RunPodMetric
					label="Current safety burn"
					value={`${money(model.costs.providerInfrastructure.hourlyBurn)}/hr`}
					chart={
						<LiveMetricChart
							label="RunPod hourly safety burn"
							samples={samples}
							series={[{ key: "hourlyBurn", label: "Burn" }]}
							formatValue={(value) => `$${value.toFixed(3)}/hr`}
						/>
					}
				/>
				<RunPodMetric
					label="Estimated spend"
					value={money(model.costs.providerInfrastructure.estimatedCost)}
					chart={
						<LiveMetricChart
							label="Estimated RunPod infrastructure spend"
							samples={samples}
							series={[{ key: "estimatedCost", label: "Estimated" }]}
							formatValue={(value) => `$${value.toFixed(3)}`}
						/>
					}
				/>
				<RunPodMetric
					label="Live Pods"
					value={String(livePods)}
					chart={
						<LiveMetricChart
							label="Live RunPod Pod count"
							samples={samples}
							series={[{ key: "livePods", label: "Pods" }]}
							formatValue={(value) => value.toFixed(0)}
						/>
					}
				/>
			</div>
		</Panel>
	);
}

function RunPodMetric({
	label,
	value,
	chart,
}: {
	label: string;
	value: string;
	chart: ReactNode;
}) {
	return (
		<section
			className="min-w-0 border p-3"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="text-xs" style={{ color: "var(--mfw-fg-faint)" }}>
				{label}
			</div>
			<div className="mfw-num mb-3 text-2xl">{value}</div>
			{chart}
		</section>
	);
}

type RunPodAuditEntry = Model["audit"][number];

function runPodAuditSummary(entry: RunPodAuditEntry): string {
	const detail =
		entry.detail && typeof entry.detail === "object"
			? (entry.detail as Record<string, unknown>)
			: {};
	for (const key of ["reason", "decision", "result", "errorCode", "state"]) {
		const value = detail[key];
		if (typeof value === "string" && value.trim())
			return value.replaceAll("_", " ");
	}
	const labels: Record<string, string> = {
		inventory:
			"Live account inventory was refreshed and compared with durable ownership records.",
		inventory_failure:
			"The live account inventory could not be refreshed; remote dispatch remained closed.",
		operator_policy_updated:
			"The machine safety policy was changed by the local operator.",
		operator_policy_rejected:
			"A requested machine policy change was rejected by safety validation.",
		operator_cleanup_confirmed:
			"An operator-confirmed owned Pod cleanup was requested.",
		untracked_owned_pod:
			"A live mfw-owned Pod was found without a matching local lease.",
		create: "A RunPod Pod creation lifecycle transition was recorded.",
		delete: "A RunPod Pod deletion lifecycle transition was recorded.",
		reconcile: "Live provider state and durable mfw state were reconciled.",
		adopt: "A surviving owned Pod was adopted after recovery.",
	};
	return (
		labels[entry.kind] ?? "A durable RunPod safety transition was recorded."
	);
}

function RunPodAuditPanel({
	open,
	onOpenChange,
	entries,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entries: Model["audit"];
}) {
	return (
		<Panel
			title="RunPod activity"
			actions={
				<Button
					size="xs"
					variant="ghost"
					aria-expanded={open}
					onClick={() => onOpenChange(!open)}
				>
					{open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
					{open ? "Hide history" : `Show history (${entries.length})`}
				</Button>
			}
		>
			{!open ? (
				<p style={{ color: "var(--mfw-fg-muted)" }}>
					Durable provider decisions, inventory checks, policy changes, and
					cleanup history. Open this only when investigating account behavior.
				</p>
			) : entries.length === 0 ? (
				<Empty title="No RunPod activity yet" />
			) : (
				<ol className="flex flex-col gap-3">
					{entries.map((entry) => (
						<li
							key={entry.id}
							className="flex flex-col gap-1 border-b pb-3"
							style={{ borderColor: "var(--mfw-border)" }}
						>
							<strong className="capitalize">
								{entry.kind.replaceAll("_", " ")}
							</strong>
							<p style={{ color: "var(--mfw-fg-muted)" }}>
								{runPodAuditSummary(entry)}
							</p>
							<time
								className="mfw-num text-xs"
								style={{ color: "var(--mfw-fg-faint)" }}
								dateTime={new Date(entry.createdAt).toISOString()}
							>
								{new Date(entry.createdAt).toLocaleString()}
							</time>
						</li>
					))}
				</ol>
			)}
		</Panel>
	);
}
