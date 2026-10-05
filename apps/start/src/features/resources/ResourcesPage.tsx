import type { AppRouter } from "@mfw/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TRPCClientErrorLike } from "@trpc/client";
import {
	ChevronDown,
	ChevronRight,
	CircleAlert,
	RefreshCw,
	RotateCcw,
	ScanSearch,
	ShieldAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "~/components/ConfirmDialog";
import { Empty } from "~/components/Empty";
import { ErrorState } from "~/components/ErrorState";
import {
	LiveMetricChart,
	type LiveMetricSample,
	useRollingMetricSamples,
} from "~/components/LiveMetricChart";
import { LoadingRows } from "~/components/Loading";
import { Chip, Page, PageHeader, Panel, Scroller } from "~/components/Page";
import { RelativeTime, useNow } from "~/components/RelativeTime";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useToast } from "~/lib/toast";
import type { RouterOutputs } from "~/lib/trpc";
import { useTRPC } from "~/lib/trpc";
import { Setting } from "../settings/controls";
import {
	formatCapacity,
	formatHoldReason,
	isObservationStale,
	LIVE_LEASE_STATES,
	observationFreshness,
} from "./resourceFormat";

type Model = RouterOutputs["hostResources"]["read"];
type Definition = Model["definitions"][number];
type Lease = Model["leases"][number];
type ApiError = TRPCClientErrorLike<AppRouter>;
type Detection = RouterOutputs["hostResources"]["detect"];

const AUDIT_ACTOR = "local-operator";
export const HOST_RESOURCES_REFETCH_MS = 5_000;

export function ResourcesPage() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const resources = useQuery({
		...trpc.hostResources.read.queryOptions(),
		// Host observations change independently of project events. A bounded poll
		// keeps this process-global read model honest even during a quiet fleet.
		refetchInterval: HOST_RESOURCES_REFETCH_MS,
	});
	const [auditOpen, setAuditOpen] = useState(false);
	const audit = useQuery({
		...trpc.hostResources.audit.queryOptions({ limit: 50 }),
		enabled: auditOpen,
	});
	const detection = useQuery({
		...trpc.hostResources.detect.queryOptions(),
		enabled: false,
	});
	const [detectOpen, setDetectOpen] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [conflict, setConflict] = useState<string | null>(null);
	const [force, setForce] = useState<Lease | null>(null);
	const [forceReason, setForceReason] = useState("");

	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries(trpc.hostResources.read.queryFilter()),
			queryClient.invalidateQueries(trpc.hostResources.audit.queryFilter()),
		]);
	};
	const mutationError = (error: ApiError) => {
		if (error.data?.code === "CONFLICT") {
			setConflict(
				"Host resource state changed before this action was applied. Reloaded values are shown; review them and try again.",
			);
		}
	};

	const refresh = useMutation(
		trpc.hostResources.refresh.mutationOptions({
			meta: { label: "Refresh host observations" },
			onSuccess: () =>
				toast({ tone: "success", title: "Host observations refreshed" }),
			onSettled: invalidate,
		}),
	);
	const reconcile = useMutation(
		trpc.hostResources.reconcile.mutationOptions({
			meta: { label: "Reconcile host resources" },
			onSuccess: (report) =>
				toast({
					tone: report.uncertain > 0 ? "warning" : "success",
					title: `Reconciled ${report.examined} lease${report.examined === 1 ? "" : "s"}`,
					description: `${report.adopted} adopted, ${report.reclaimed} reclaimed, ${report.uncertain} uncertain`,
				}),
			onSettled: invalidate,
		}),
	);
	const setDrain = useMutation(
		trpc.hostResources.setDrain.mutationOptions({
			meta: { label: "Change resource drain" },
			onError: mutationError,
			onSettled: invalidate,
		}),
	);
	const setEnabled = useMutation(
		trpc.hostResources.setEnabled.mutationOptions({
			meta: { label: "Change resource availability" },
			onError: mutationError,
			onSettled: invalidate,
		}),
	);
	const forceRelease = useMutation(
		trpc.hostResources.forceRelease.mutationOptions({
			meta: { label: "Force release host lease" },
			onError: mutationError,
			onSuccess: (changed) => {
				setForce(null);
				setForceReason("");
				toast({
					tone: "success",
					title: changed
						? "Host lease force-released"
						: "Lease was already force-released",
				});
			},
			onSettled: invalidate,
		}),
	);
	const applyDetected = useMutation(
		trpc.hostResources.applyDetected.mutationOptions({
			meta: { label: "Configure detected host resources" },
			onError: mutationError,
			onSuccess: async (result) => {
				toast({
					tone: "success",
					title: "Host resources configured",
					description: `${result.definitionsCreated} resource${result.definitionsCreated === 1 ? "" : "s"} and ${result.bindingsCreated} GPU${result.bindingsCreated === 1 ? "" : "s"} added.`,
				});
				await invalidate();
				await detection.refetch();
			},
		}),
	);

	const model = resources.data;
	return (
		<Page className="h-full">
			<PageHeader
				title="Host Resources"
				meta="Shared CPU, RAM, and GPU capacity available to projects on this host"
				actions={
					<Button
						size="sm"
						variant="outline"
						disabled={detection.isFetching}
						onClick={() => {
							setDetectOpen(true);
							void detection.refetch();
						}}
					>
						<ScanSearch aria-hidden /> Detect resources
					</Button>
				}
			/>
			<Scroller className="flex flex-col gap-3 p-3">
				{conflict ? (
					<div
						role="alert"
						className="flex items-start gap-2 border p-3"
						style={{ borderColor: "var(--mfw-warn)", color: "var(--mfw-warn)" }}
					>
						<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
						<span>{conflict}</span>
						<Button size="xs" variant="ghost" onClick={() => setConflict(null)}>
							Dismiss
						</Button>
					</div>
				) : null}

				{resources.isLoading ? (
					<LoadingRows rows={6} />
				) : resources.error ? (
					<ErrorState
						title="Could not read host resources"
						error={resources.error}
						onRetry={() => void resources.refetch()}
					/>
				) : model ? (
					<>
						{detectOpen ? (
							<DetectedResourcesPanel
								data={detection.data}
								loading={detection.isFetching}
								error={detection.error}
								pending={applyDetected.isPending}
								onClose={() => setDetectOpen(false)}
								onRetry={() => void detection.refetch()}
								onApply={() => {
									if (!detection.data) return;
									const recommendations = detection.data.recommendations
										.filter((item) => item.canApply)
										.map((item) => ({
											id: item.id,
											fingerprint: item.fingerprint,
										}));
									if (recommendations.length === 0) return;
									applyDetected.mutate({
										recommendations,
										expectedGeneration: detection.data.generation,
									});
								}}
							/>
						) : null}
						<ResourceCards model={model} />
						<AdvancedPanel open={advancedOpen} onOpenChange={setAdvancedOpen}>
							<ResourceControlsPanel
								model={model}
								refreshing={refresh.isPending}
								onRefresh={() => refresh.mutate({})}
								onDrain={(definition, draining) =>
									setDrain.mutate({
										resourceId: definition.id,
										expectedVersion: definition.version,
										draining,
										actor: AUDIT_ACTOR,
									})
								}
								onEnabled={(definition, enabled) =>
									setEnabled.mutate({
										resourceId: definition.id,
										expectedVersion: definition.version,
										enabled,
										actor: AUDIT_ACTOR,
										reason: enabled
											? "operator enabled host resource"
											: "operator disabled drained host resource",
									})
								}
							/>
							<OperationsPanel
								model={model}
								reconciling={reconcile.isPending}
								onReconcile={() => reconcile.mutate({})}
								onForce={setForce}
							/>
							<ObservationsPanel model={model} />
							<AuditPanel
								open={auditOpen}
								onOpenChange={setAuditOpen}
								loading={audit.isLoading}
								error={audit.error}
								entries={audit.data ?? []}
								onRetry={() => void audit.refetch()}
							/>
						</AdvancedPanel>
					</>
				) : null}
			</Scroller>

			<ConfirmDialog
				open={force !== null}
				onOpenChange={(open) => {
					if (!open) {
						setForce(null);
						setForceReason("");
					}
				}}
				title="Force release host capacity"
				confirmText={force?.id}
				confirmLabel="Force release lease"
				pending={forceRelease.isPending}
				confirmDisabled={!forceReason.trim()}
				description={
					force ? (
						<>
							Fresh liveness evidence will be checked before fence{" "}
							{force.fence.toString()} is released. The run is never signalled,
							and observed external or unknown occupants are never targeted.
						</>
					) : null
				}
				onConfirm={() => {
					if (!force || !forceReason.trim()) return;
					forceRelease.mutate({
						leaseId: force.id,
						expectedFence: force.fence,
						actor: AUDIT_ACTOR,
						reason: forceReason,
						confirmed: true,
					});
				}}
			>
				<Setting label="Audit reason">
					<Input
						aria-label="Force release reason"
						value={forceReason}
						onChange={(event) => setForceReason(event.target.value)}
					/>
				</Setting>
				{!forceReason.trim() ? (
					<p role="status" style={{ color: "var(--mfw-warn)" }}>
						A reason is required for the recovery audit trail.
					</p>
				) : null}
			</ConfirmDialog>
		</Page>
	);
}

function DetectedResourcesPanel({
	data,
	loading,
	error,
	pending,
	onClose,
	onRetry,
	onApply,
}: {
	data: Detection | undefined;
	loading: boolean;
	error: unknown;
	pending: boolean;
	onClose: () => void;
	onRetry: () => void;
	onApply: () => void;
}) {
	return (
		<Panel
			title="Detected host resources"
			actions={
				<Button size="xs" variant="ghost" onClick={onClose}>
					Close
				</Button>
			}
		>
			<p className="mb-3" style={{ color: "var(--mfw-fg-muted)" }}>
				These proposals come from this host&apos;s CPU, memory, and GPU probes.
				Detection never changes capacity by itself. Review what mfw found, then
				confirm once to make every new resource available to tasks.
			</p>
			{data && !loading && !error ? (
				<p
					role="status"
					className="mb-3"
					style={{
						color:
							data.probe.status === "fresh"
								? "var(--mfw-ok)"
								: "var(--mfw-warn)",
					}}
				>
					{data.probe.status === "fresh"
						? "Fresh hardware check completed "
						: data.probe.status === "partial"
							? "Hardware check completed with unavailable probes "
							: "Hardware refresh unavailable "}
					<RelativeTime value={data.probe.checkedAt} />.
					{data.probe.unavailableKinds.length > 0
						? ` ${data.probe.unavailableKinds.length} unavailable probe${data.probe.unavailableKinds.length === 1 ? " was" : "s were"} excluded.`
						: null}
				</p>
			) : null}
			{loading ? (
				<div role="status">
					<p className="mb-2" style={{ color: "var(--mfw-fg-muted)" }}>
						Running a fresh hardware check… Previous recommendations are hidden
						until it finishes.
					</p>
					<LoadingRows rows={3} />
				</div>
			) : error ? (
				<ErrorState
					title="Could not detect host resources"
					error={error}
					onRetry={onRetry}
				/>
			) : !data || data.recommendations.length === 0 ? (
				<Empty
					title="No resources detected by the fresh check"
					description="Detection fails closed: it only proposes hardware supported by a healthy probe from this refresh."
				/>
			) : (
				<>
					<ul className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
						{data.recommendations.map((recommendation) => {
							const definition = recommendation.definition;
							const configured =
								!recommendation.canApply &&
								recommendation.definitionState !== "conflict" &&
								recommendation.bindingConflictIds.length === 0;
							return (
								<li
									key={recommendation.id}
									className="flex min-w-0 flex-col gap-2 border p-3"
									style={{
										borderColor:
											recommendation.definitionState === "conflict" ||
											recommendation.bindingConflictIds.length > 0
												? "var(--mfw-warn)"
												: "var(--mfw-border)",
									}}
								>
									<div className="flex flex-wrap items-center gap-2">
										<strong>{recommendation.label}</strong>
										<Chip>
											{formatCapacity(
												definition.capacity,
												definition.quantityUnit ?? null,
											)}
										</Chip>
										{configured &&
										recommendation.definitionState !== "conflict" ? (
											<Chip tone="ok">Configured</Chip>
										) : null}
									</div>
									<p style={{ color: "var(--mfw-fg-muted)" }}>
										{recommendation.description}
									</p>
									{recommendation.bindings.length > 0 ? (
										<p
											className="text-xs"
											style={{ color: "var(--mfw-fg-faint)" }}
										>
											{recommendation.bindings.length} detected GPU
											{recommendation.bindings.length === 1 ? "" : "s"};{" "}
											{recommendation.missingBindingIds.length} new
										</p>
									) : null}
									{recommendation.definitionState === "conflict" ||
									recommendation.bindingConflictIds.length > 0 ? (
										<p role="status" style={{ color: "var(--mfw-warn)" }}>
											This does not match the host resources already saved, so
											no changes were made. Open Advanced diagnostics and
											recovery, refresh the hardware check, then detect again.
										</p>
									) : null}
								</li>
							);
						})}
					</ul>
					<div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
						<p style={{ color: "var(--mfw-fg-muted)" }}>
							{data.recommendations.filter((item) => item.canApply).length === 0
								? "Everything detected is already configured."
								: "CPU, RAM, and each detected GPU will be configured together."}
						</p>
						<Button
							disabled={
								pending || !data.recommendations.some((item) => item.canApply)
							}
							onClick={onApply}
						>
							{pending ? "Configuring…" : "Confirm resource setup"}
						</Button>
					</div>
				</>
			)}
		</Panel>
	);
}

function resourceName(definition: Definition): string {
	if (definition.id === "cpu") return "CPU";
	if (definition.id === "ram") return "RAM";
	if (definition.id === "gpu-amd") return "AMD GPU";
	if (definition.id === "gpu-nvidia") return "NVIDIA GPU";
	return definition.id.replaceAll("-", " ");
}

function ResourceCards({ model }: { model: Model }) {
	return (
		<Panel title="Live host monitor">
			<p className="mb-3" style={{ color: "var(--mfw-fg-muted)" }}>
				Whole-host values refresh every five seconds, including work outside
				MFW. Charts are bounded to this page session. Configured and Reserved
				remain MFW admission limits; they are not kernel-enforced utilization
				limits.
			</p>
			{model.definitions.length === 0 ? (
				<Empty
					title="No host resources configured"
					description="Choose Detect resources above to find this machine's CPU, RAM, and GPUs. Nothing is added until you review and confirm."
				/>
			) : (
				<ul className="grid gap-3 xl:grid-cols-2">
					{model.definitions.map((definition) => {
						const capacity = model.effectiveCapacities.find(
							(item) => item.resourceId === definition.id,
						);
						const devices = model.bindings.filter(
							(item) => item.resourceId === definition.id,
						);
						return (
							<ResourceMonitorCard
								key={definition.id}
								definition={definition}
								capacity={capacity}
								deviceCount={devices.length}
								observations={model.observations}
								health={model.health}
							/>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

type Capacity = Model["effectiveCapacities"][number];
type Observation = Model["observations"][number];
type Health = Model["health"][number];

function objectMetric(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numericMetric(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value))
		return Number(value);
	return null;
}

function bytesToGiB(value: unknown): number | null {
	const bytes = numericMetric(value);
	return bytes === null || !Number.isFinite(bytes)
		? null
		: bytes / (1024 * 1024 * 1024);
}

function latestObservation(
	observations: readonly Observation[],
	kind: string | null,
): Observation | null {
	if (!kind) return null;
	return (
		observations
			.filter((item) => item.kind === kind)
			.sort((left, right) => right.observedAt - left.observedAt)[0] ?? null
	);
}

function telemetrySample(
	definition: Definition,
	capacity: Capacity,
	observations: readonly Observation[],
	health: readonly Health[],
): LiveMetricSample {
	const healthEntry = health.find(
		(item) => item.kind === definition.observationKind,
	);
	const observation = latestObservation(
		observations,
		definition.observationKind ?? null,
	);
	const at =
		observation?.observedAt ??
		healthEntry?.checkedAt ??
		capacity.observation?.observedAt ??
		Date.now();
	if (definition.observationKind === "linux-cpu") {
		return {
			at,
			values: {
				busyPercent: capacity.cpuPressure
					? capacity.cpuPressure.busyFraction * 100
					: null,
				runnable: capacity.cpuPressure?.runnableProcesses ?? null,
			},
		};
	}
	if (definition.observationKind === "linux-memory") {
		const latest = objectMetric(healthEntry?.detail?.latest);
		const metrics = observation?.metrics ?? latest ?? {};
		const available =
			bytesToGiB(metrics.memAvailableBytes) ??
			bytesToGiB(capacity.ramFormula?.memAvailableBytes);
		const total = bytesToGiB(metrics.memTotalBytes);
		const swapTotal = bytesToGiB(metrics.swapTotalBytes);
		const swapFree = bytesToGiB(metrics.swapFreeBytes);
		return {
			at,
			values: {
				usedGiB:
					available !== null && total !== null ? total - available : null,
				availableGiB: available,
				usedPercent:
					available !== null && total !== null && total > 0
						? ((total - available) / total) * 100
						: null,
				swapUsedGiB:
					swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
			},
		};
	}
	const devices = capacity.gpuOccupancy;
	const utilization = devices.flatMap((item) =>
		item.gpuUtilization === null ? [] : [item.gpuUtilization * 100],
	);
	const used = devices.reduce(
		(total, item) => total + Number(item.memoryUsedBytes ?? 0n),
		0,
	);
	const memoryTotal = devices.reduce(
		(total, item) => total + Number(item.memoryTotalBytes ?? 0n),
		0,
	);
	const temperatures = devices.flatMap((item) =>
		item.temperatureCelsius === null ? [] : [item.temperatureCelsius],
	);
	const powers = devices.flatMap((item) =>
		item.powerWatts === null ? [] : [item.powerWatts],
	);
	return {
		at,
		values: {
			utilizationPercent: utilization.length ? Math.max(...utilization) : null,
			memoryUsedGiB: devices.some((item) => item.memoryUsedBytes !== null)
				? used / (1024 * 1024 * 1024)
				: null,
			memoryTotalGiB:
				memoryTotal > 0 ? memoryTotal / (1024 * 1024 * 1024) : null,
			temperatureCelsius: temperatures.length
				? Math.max(...temperatures)
				: null,
			powerWatts: powers.length
				? powers.reduce((sum, value) => sum + value, 0)
				: null,
			contexts: devices.reduce(
				(total, item) => total + item.occupants.length,
				0,
			),
		},
	};
}

function PercentageBar({ value }: { value: number | null }) {
	const bounded = value === null ? 0 : Math.max(0, Math.min(100, value));
	return (
		<>
			<meter className="sr-only" min={0} max={100} value={bounded}>
				{bounded}%
			</meter>
			<div
				aria-hidden
				className="h-2 overflow-hidden border"
				style={{ borderColor: "var(--mfw-border)" }}
			>
				<div
					className="h-full transition-[width] duration-300"
					style={{ width: `${bounded}%`, background: "var(--mfw-accent)" }}
				/>
			</div>
		</>
	);
}

function LiveValue({ label, value }: { label: string; value: string }) {
	return (
		<div
			className="border px-2 py-1.5"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="text-xs" style={{ color: "var(--mfw-fg-faint)" }}>
				{label}
			</div>
			<div className="mfw-num">{value}</div>
		</div>
	);
}

function ResourceMonitorCard({
	definition,
	capacity,
	deviceCount,
	observations,
	health,
}: {
	definition: Definition;
	capacity: Capacity | undefined;
	deviceCount: number;
	observations: readonly Observation[];
	health: readonly Health[];
}) {
	const current = capacity
		? telemetrySample(definition, capacity, observations, health)
		: null;
	const samples = useRollingMetricSamples(current);
	const values = current?.values ?? {};
	const isCpu = definition.observationKind === "linux-cpu";
	const isRam = definition.observationKind === "linux-memory";
	const primary = isCpu
		? values.busyPercent
		: isRam
			? values.usedPercent
			: values.utilizationPercent;
	return (
		<li className="flex min-w-0 flex-col gap-3 border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<strong>{resourceName(definition)}</strong>
				<Chip
					tone={
						!definition.enabled
							? "critical"
							: definition.draining
								? "warn"
								: "neutral"
					}
				>
					{!definition.enabled
						? "Unavailable"
						: definition.draining
							? "Finishing current work"
							: "Enabled"}
				</Chip>
				{deviceCount > 0 ? (
					<Chip>
						{deviceCount} GPU{deviceCount === 1 ? "" : "s"}
					</Chip>
				) : null}
				<span className="ml-auto mfw-num text-xl">
					{primary === null || primary === undefined
						? "-"
						: `${primary.toFixed(1)}%`}
				</span>
			</div>
			<PercentageBar value={primary ?? null} />
			{isCpu ? (
				<LiveMetricChart
					label="CPU busy time"
					samples={samples}
					series={[{ key: "busyPercent", label: "Busy" }]}
					maximum={100}
					formatValue={(value) => `${value.toFixed(1)}%`}
				/>
			) : isRam ? (
				<LiveMetricChart
					label="Host memory"
					samples={samples}
					series={[
						{ key: "usedGiB", label: "Used" },
						{ key: "availableGiB", label: "Available" },
					]}
					formatValue={(value) => `${value.toFixed(1)} GiB`}
				/>
			) : (
				<LiveMetricChart
					label={`${resourceName(definition)} activity`}
					samples={samples}
					series={[{ key: "utilizationPercent", label: "GPU" }]}
					maximum={100}
					formatValue={(value) => `${value.toFixed(1)}%`}
				/>
			)}
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{isCpu ? (
					<>
						<LiveValue
							label="Runnable"
							value={values.runnable?.toFixed(0) ?? "-"}
						/>
						<LiveValue
							label="MFW reserved"
							value={
								capacity
									? formatCapacity(
											capacity.durablePromises,
											capacity.quantityUnit,
										)
									: "-"
							}
						/>
					</>
				) : isRam ? (
					<>
						<LiveValue
							label="Used"
							value={
								values.usedGiB == null
									? "-"
									: `${values.usedGiB.toFixed(1)} GiB`
							}
						/>
						<LiveValue
							label="Available"
							value={
								values.availableGiB == null
									? "-"
									: `${values.availableGiB.toFixed(1)} GiB`
							}
						/>
						<LiveValue
							label="Swap used"
							value={
								values.swapUsedGiB == null
									? "-"
									: `${values.swapUsedGiB.toFixed(1)} GiB`
							}
						/>
					</>
				) : (
					<>
						<LiveValue
							label="Memory"
							value={
								values.memoryUsedGiB == null
									? "-"
									: `${values.memoryUsedGiB.toFixed(1)} / ${values.memoryTotalGiB?.toFixed(1) ?? "?"} GiB`
							}
						/>
						<LiveValue
							label="Temperature"
							value={
								values.temperatureCelsius == null
									? "-"
									: `${values.temperatureCelsius.toFixed(0)} °C`
							}
						/>
						<LiveValue
							label="Power"
							value={
								values.powerWatts == null
									? "-"
									: `${values.powerWatts.toFixed(0)} W`
							}
						/>
						<LiveValue
							label="Observed contexts"
							value={values.contexts?.toFixed(0) ?? "-"}
						/>
					</>
				)}
			</div>
			{capacity ? <CapacityGrid capacity={capacity} /> : null}
			{capacity?.holdReason ? (
				<p role="status" style={{ color: "var(--mfw-warn)" }}>
					{formatHoldReason(capacity.holdReason)}
				</p>
			) : null}
		</li>
	);
}

function ResourceControlsPanel({
	model,
	refreshing,
	onRefresh,
	onDrain,
	onEnabled,
}: {
	model: Model;
	refreshing: boolean;
	onRefresh: () => void;
	onDrain: (definition: Definition, draining: boolean) => void;
	onEnabled: (definition: Definition, enabled: boolean) => void;
}) {
	return (
		<Panel
			title="Hardware checks and availability"
			actions={
				<Button
					size="xs"
					variant="outline"
					disabled={refreshing}
					onClick={onRefresh}
				>
					<RefreshCw aria-hidden /> Refresh hardware check
				</Button>
			}
		>
			<p className="mb-3" style={{ color: "var(--mfw-fg-muted)" }}>
				Use these controls only to stop new work before maintenance or to
				recover a resource after maintenance.
			</p>
			<ul className="flex flex-col gap-2">
				{model.definitions.map((definition) => (
					<li
						key={definition.id}
						className="flex flex-wrap items-center gap-2 border p-2"
					>
						<strong>{resourceName(definition)}</strong>
						<span className="flex-1" />
						<Button
							size="xs"
							variant="ghost"
							onClick={() => onDrain(definition, !definition.draining)}
						>
							{definition.draining ? "Allow new work" : "Finish current work"}
						</Button>
						<Button
							size="xs"
							variant={definition.enabled ? "destructive" : "outline"}
							disabled={definition.enabled && !definition.draining}
							onClick={() => onEnabled(definition, !definition.enabled)}
						>
							{definition.enabled ? "Make unavailable" : "Make available"}
						</Button>
					</li>
				))}
			</ul>
		</Panel>
	);
}

function AdvancedPanel({
	open,
	onOpenChange,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<Panel
			title="Advanced diagnostics and recovery"
			actions={
				<Button
					size="xs"
					variant="ghost"
					aria-expanded={open}
					onClick={() => onOpenChange(!open)}
				>
					{open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
					{open ? "Hide advanced" : "Show advanced"}
				</Button>
			}
		>
			{open ? (
				<div className="flex flex-col gap-3">{children}</div>
			) : (
				<p style={{ color: "var(--mfw-fg-muted)" }}>
					Lease recovery, probe diagnostics, and host activity for exceptional
					troubleshooting.
				</p>
			)}
		</Panel>
	);
}

function CapacityGrid({
	capacity,
}: {
	capacity: Model["effectiveCapacities"][number];
}) {
	const now = useNow();
	const freshness = observationFreshness(
		capacity.observation,
		capacity.holdReason,
		now,
	);
	const values = [
		[
			"Configured",
			formatCapacity(capacity.configuredQuota, capacity.quantityUnit),
		],
		[
			"Reserved",
			formatCapacity(capacity.durablePromises, capacity.quantityUnit),
		],
		[
			"Free on host",
			formatCapacity(capacity.observedCapacity, capacity.quantityUnit),
		],
		[
			"Available to tasks",
			formatCapacity(capacity.effectiveCapacity, capacity.quantityUnit),
		],
	] as const;
	return (
		<div className="flex flex-col gap-2">
			<dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{values.map(([label, value]) => (
					<div
						key={label}
						className="border p-2"
						style={{ borderColor: "var(--mfw-border)" }}
					>
						<dt
							style={{
								color: "var(--mfw-fg-faint)",
								fontSize: "var(--mfw-text-2xs)",
							}}
						>
							{label}
						</dt>
						<dd className="mfw-num m-0">{value}</dd>
					</div>
				))}
			</dl>
			{freshness !== "not-required" ? (
				<div
					className="flex flex-wrap items-center gap-1.5"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					<span>Hardware check</span>
					<Chip tone={freshness === "fresh" ? "ok" : "warn"}>
						{freshness === "fresh"
							? "Fresh"
							: freshness === "stale"
								? "Stale"
								: freshness === "ignored"
									? "Ignored by policy"
									: "Unavailable"}
					</Chip>
					{capacity.observation?.observedAt != null ? (
						<span>
							observed <RelativeTime value={capacity.observation.observedAt} />
						</span>
					) : (
						<span>No current observation</span>
					)}
				</div>
			) : null}
		</div>
	);
}

function OperationsPanel({
	model,
	reconciling,
	onReconcile,
	onForce,
}: {
	model: Model;
	reconciling: boolean;
	onReconcile: () => void;
	onForce: (lease: Lease) => void;
}) {
	const liveLeases = model.leases.filter((lease) =>
		LIVE_LEASE_STATES.has(lease.state),
	);
	return (
		<Panel
			title="Waiters, leases, and recovery"
			actions={
				<Button
					size="xs"
					variant="outline"
					disabled={reconciling}
					onClick={onReconcile}
					title="Check durable leases against current run liveness"
				>
					<RotateCcw aria-hidden />
					{reconciling ? "Checking…" : "Check lease recovery"}
				</Button>
			}
		>
			<p className="mb-3" style={{ color: "var(--mfw-fg-muted)" }}>
				Lease recovery is crash cleanup, not hardware detection. It checks
				durable reservations against current run liveness, adopts proven live
				work, reclaims proven absent work, and keeps uncertain capacity held.
			</p>
			<div className="grid gap-4 lg:grid-cols-2">
				<section>
					<h3 className="mb-2">Ordered waiters</h3>
					{model.waiters.length === 0 ? (
						<p style={{ color: "var(--mfw-fg-faint)" }}>No durable waiters.</p>
					) : (
						<ol className="flex flex-col gap-2">
							{model.waiters.map((waiter) => (
								<li
									key={waiter.id}
									className="border p-2"
									style={{ borderColor: "var(--mfw-border)" }}
								>
									<div className="flex flex-wrap gap-2">
										<span className="mfw-num">
											#{waiter.sequence.toString()}
										</span>
										<Chip>{waiter.state}</Chip>
										<span className="mfw-num">{waiter.projectId}</span>
									</div>
									<p className="mfw-num text-xs">
										{waiter.requirements
											.map(
												(item) =>
													`${item.resourceId} × ${item.amount.toString()}`,
											)
											.join(", ")}
									</p>
								</li>
							))}
						</ol>
					)}
				</section>
				<section>
					<h3 className="mb-2">Leases and fences</h3>
					{model.leases.length === 0 ? (
						<p style={{ color: "var(--mfw-fg-faint)" }}>
							No leases have been recorded.
						</p>
					) : (
						<ul className="flex flex-col gap-2">
							{model.leases.map((lease) => (
								<li
									key={lease.id}
									className="border p-2"
									style={{
										borderColor:
											lease.state === "uncertain"
												? "var(--mfw-warn)"
												: "var(--mfw-border)",
									}}
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="mfw-num">{lease.id}</span>
										<Chip
											tone={
												lease.state === "uncertain"
													? "warn"
													: LIVE_LEASE_STATES.has(lease.state)
														? "accent"
														: "neutral"
											}
										>
											{lease.state}
										</Chip>
										<Chip>fence {lease.fence.toString()}</Chip>
										<span className="mfw-num">project {lease.projectId}</span>
										<span className="flex-1" />
										{LIVE_LEASE_STATES.has(lease.state) ? (
											<Button
												size="xs"
												variant="destructive"
												onClick={() => onForce(lease)}
											>
												<ShieldAlert aria-hidden /> Guarded force
											</Button>
										) : null}
									</div>
									<p className="mfw-num text-xs">
										{lease.allocations
											.map(
												(item) =>
													`${item.resourceId}${item.bindingId ? `/${item.bindingId}` : ""} × ${item.amount.toString()}`,
											)
											.join(", ")}
									</p>
									{lease.run ? (
										<p className="mfw-num text-xs">
											run {lease.run.runId}; pid {lease.run.pid ?? "unknown"}
										</p>
									) : null}
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
			{liveLeases.some((lease) => lease.state === "uncertain") ? (
				<p role="status" className="mt-3" style={{ color: "var(--mfw-warn)" }}>
					Uncertain leases continue to hold capacity. Run lease recovery or use
					guarded force only after reviewing liveness evidence.
				</p>
			) : null}
		</Panel>
	);
}

function ObservationsPanel({ model }: { model: Model }) {
	const external = model.occupants.flatMap((occupancy) =>
		occupancy.occupants
			.filter((item) => item.attribution !== "managed")
			.map((occupant) => ({ occupancy, occupant })),
	);
	return (
		<Panel title="Observation health and occupants">
			<div className="grid gap-4 lg:grid-cols-2">
				<section>
					<h3 className="mb-2">Probe health</h3>
					{model.health.length === 0 ? (
						<p role="status" style={{ color: "var(--mfw-fg-faint)" }}>
							No probe health has been recorded. Observed capacity remains
							unknown.
						</p>
					) : (
						<ul className="flex flex-col gap-2">
							{model.health.map((health) => (
								<li
									key={health.kind}
									className="flex flex-wrap items-center gap-2"
								>
									<span className="mfw-num">{health.kind}</span>
									<Chip
										tone={
											health.result === "ok"
												? "ok"
												: health.result === "degraded"
													? "warn"
													: "critical"
										}
									>
										{health.result}
									</Chip>
									<span>
										checked {new Date(health.checkedAt).toLocaleString()}
									</span>
									{health.processBootId !== model.processBootId ? (
										<Chip tone="critical">previous process</Chip>
									) : null}
									{health.kernelBootId !== model.kernelBootId ? (
										<Chip tone="critical">previous boot</Chip>
									) : null}
								</li>
							))}
						</ul>
					)}
					{model.effectiveCapacities.some((item) =>
						isObservationStale(item.holdReason),
					) ? (
						<p
							role="alert"
							className="mt-2"
							style={{ color: "var(--mfw-warn)" }}
						>
							At least one required observation is stale; effective capacity is
							zero until a fresh current-boot sample arrives.
						</p>
					) : null}
				</section>
				<section>
					<h3 className="mb-2">External and unknown GPU occupants</h3>
					{external.length === 0 ? (
						<p style={{ color: "var(--mfw-fg-faint)" }}>
							No external or unknown GPU occupants are currently observed.
						</p>
					) : (
						<ul className="flex flex-col gap-2">
							{external.map(({ occupancy, occupant }) => (
								<li
									key={`${occupancy.bindingId}:${occupant.pid}`}
									className="border p-2"
									style={{ borderColor: "var(--mfw-warn)" }}
								>
									<div className="flex flex-wrap gap-2">
										<Chip
											tone={
												occupant.attribution === "external"
													? "warn"
													: "critical"
											}
										>
											{occupant.attribution}
										</Chip>
										<span className="mfw-num">pid {occupant.pid}</span>
										<span className="mfw-num">
											{occupancy.resourceId}/{occupancy.bindingId}
										</span>
										<Chip>{occupancy.state}</Chip>
										{occupancy.memoryUsedBytes !== null ? (
											<span className="mfw-num">
												{formatCapacity(occupancy.memoryUsedBytes, "bytes")}{" "}
												used
											</span>
										) : null}
									</div>
									<p className="text-xs">
										This observation blocks exclusive admission. MFW never
										signals or force-releases this occupant.
									</p>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
			{model.incidents.length > 0 || model.holds.length > 0 ? (
				<section className="mt-4">
					<h3>Open and recovered evidence</h3>
					<ul className="mt-2 flex flex-col gap-1">
						{model.incidents.map((incident) => (
							<li key={incident.key} className="flex gap-2">
								<Chip tone={incident.state === "open" ? "critical" : "neutral"}>
									{incident.state}
								</Chip>
								<span>
									{incident.kind}: {incident.resourceId}
								</span>
							</li>
						))}
						{model.holds.map((hold) => (
							<li key={hold.resourceId} className="flex gap-2">
								<Chip tone={hold.state === "open" ? "warn" : "neutral"}>
									{hold.state}
								</Chip>
								<span>
									{hold.resourceId}: {formatHoldReason(hold.reason)}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</Panel>
	);
}

function AuditPanel({
	open,
	onOpenChange,
	loading,
	error,
	entries,
	onRetry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	loading: boolean;
	error: unknown;
	entries: RouterOutputs["hostResources"]["audit"];
	onRetry: () => void;
}) {
	return (
		<Panel
			title="Host activity"
			actions={
				<Button
					size="xs"
					variant="ghost"
					aria-expanded={open}
					onClick={() => onOpenChange(!open)}
				>
					{open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
					{open ? "Hide history" : "Show history"}
				</Button>
			}
		>
			{!open ? (
				<p style={{ color: "var(--mfw-fg-muted)" }}>
					Durable probe, admission, lease, and recovery history. Kept closed
					unless you need to investigate a host-resource decision.
				</p>
			) : loading ? (
				<LoadingRows rows={4} />
			) : error ? (
				<ErrorState
					title="Could not read host audit"
					error={error}
					onRetry={onRetry}
				/>
			) : entries.length === 0 ? (
				<Empty
					title="No host resource audit yet"
					description="Definition, observation, lease, recovery, and force actions appear here."
				/>
			) : (
				<ol className="flex flex-col gap-3">
					{[...entries].reverse().map((entry) => (
						<li
							key={entry.seq.toString()}
							className="flex flex-col gap-1 border-b pb-3"
							style={{ borderColor: "var(--mfw-border)" }}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{auditTitle(entry)}</span>
								{auditStatus(entry)}
							</div>
							<p style={{ color: "var(--mfw-fg-muted)" }}>
								{auditSummary(entry)}
							</p>
							<div
								className="mfw-num flex flex-wrap gap-x-3 gap-y-1 text-xs"
								style={{ color: "var(--mfw-fg-faint)" }}
							>
								<span>#{entry.seq.toString()}</span>
								<time dateTime={new Date(entry.at).toISOString()}>
									{new Date(entry.at).toLocaleString()}
								</time>
								<span>Actor: {friendlyAuditActor(entry.actor)}</span>
								{entry.projectId ? (
									<span>Project: {entry.projectId}</span>
								) : null}
								{entry.waiterId ? <span>Waiter: {entry.waiterId}</span> : null}
								{entry.leaseId ? <span>Lease: {entry.leaseId}</span> : null}
								{entry.fence !== null ? (
									<span>Fence: {entry.fence.toString()}</span>
								) : null}
							</div>
						</li>
					))}
				</ol>
			)}
		</Panel>
	);
}

type AuditEntry = RouterOutputs["hostResources"]["audit"][number];

function auditDetail(entry: AuditEntry): Record<string, unknown> {
	return entry.detail && typeof entry.detail === "object"
		? (entry.detail as Record<string, unknown>)
		: {};
}

function detailText(entry: AuditEntry, key: string): string | null {
	const value = auditDetail(entry)[key];
	return typeof value === "string" && value.trim() ? value : null;
}

function detailNumber(entry: AuditEntry, key: string): number | null {
	const value = auditDetail(entry)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function friendlyProbeKind(value: string | null): string {
	const labels: Record<string, string> = {
		"amd-gpu": "AMD GPU",
		"nvidia-gpu": "NVIDIA GPU",
		"linux-cpu": "CPU",
		"linux-memory": "Memory",
	};
	return value ? (labels[value] ?? value.replaceAll("-", " ")) : "Host probe";
}

function friendlyAuditActor(value: string): string {
	const labels: Record<string, string> = {
		"observation-service": "Probe service",
		"local-operator": "Local operator",
		orchestrator: "MFW",
		coordinator: "Host coordinator",
		"host-policy": "Host policy",
		owner: "Run owner",
	};
	return labels[value] ?? value;
}

function auditTitle(entry: AuditEntry): string {
	const kind = friendlyProbeKind(detailText(entry, "kind"));
	const labels: Record<string, string> = {
		"observation.batch": `${kind} observation refreshed`,
		"observation.health": `${kind} probe health updated`,
		"observation.recorded": `${kind} observation recorded`,
		"project.attached": "Project attached to host coordinator",
		"project.detached": "Project detached from host coordinator",
		"definition.put": "Host resource definition changed",
		"binding.put": "Hardware binding changed",
		"waiter.created": "Resource request queued",
		"waiter.cancelled": "Resource request cancelled",
		"lease.provisional": "Host capacity granted provisionally",
		"lease.activated": "Host capacity lease activated",
		"lease.releasing": "Host capacity lease releasing",
		"lease.adopted": "Host capacity lease adopted after recovery",
		"resource.hold.opened": "Host resource hold opened",
		"resource.hold.resolved": "Host resource hold resolved",
		"incident.opened": "Host resource incident opened",
		"incident.resolved": "Host resource incident resolved",
	};
	return labels[entry.action] ?? entry.action.replaceAll(".", " ");
}

function auditSummary(entry: AuditEntry): string {
	const result = detailText(entry, "result");
	const reason = detailText(entry, "reason");
	if (entry.action === "observation.batch") {
		const samples = detailNumber(entry, "samples");
		if (samples === 0) {
			return `${result ? `Probe health was ${result}. ` : ""}No configured resource bindings required a per-binding sample.`;
		}
		return `${result ? `Probe health was ${result}. ` : ""}${samples ?? "Some"} configured binding${samples === 1 ? " was" : "s were"} sampled.`;
	}
	if (entry.action === "observation.health")
		return `Probe health changed to ${result ?? "an unknown state"}.`;
	if (entry.action === "observation.recorded")
		return `A configured resource binding was sampled with status ${result ?? "unknown"}.`;
	if (entry.action === "definition.put") {
		const mutation = detailText(entry, "mutation") ?? "changed";
		const capacity = detailText(entry, "capacity");
		return `Definition ${mutation}${capacity ? ` with configured capacity ${capacity}` : ""}${reason ? `. ${reason}` : "."}`;
	}
	if (entry.action === "binding.put") {
		const resource = detailText(entry, "resourceId");
		return `Hardware binding ${detailText(entry, "mutation") ?? "changed"}${resource ? ` for ${resource}` : ""}${reason ? `. ${reason}` : "."}`;
	}
	if (reason) return reason;
	if (entry.action === "project.attached")
		return `${detailText(entry, "displayName") ?? "A project"} joined machine-wide resource coordination.`;
	if (entry.action === "project.detached")
		return "The project left machine-wide resource coordination.";
	const resources = auditDetail(entry).resources;
	if (
		Array.isArray(resources) &&
		resources.every((item) => typeof item === "string")
	)
		return `Resources: ${resources.join(", ")}.`;
	return "A durable host-resource state transition was recorded.";
}

function auditStatus(entry: AuditEntry) {
	const result = detailText(entry, "result");
	if (!result) return null;
	return (
		<Chip
			tone={
				result === "ok" ? "ok" : result === "degraded" ? "warn" : "critical"
			}
		>
			{result}
		</Chip>
	);
}
