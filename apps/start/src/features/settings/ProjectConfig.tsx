import {
	MFW_RUNPOD_CPU_RUNTIME,
	runPodCpuFlavorLabel,
	runPodImageLabel,
} from "@mfw/core/runpod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppLink } from "~/components/AppLink";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Mono } from "../../components/Cost";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Panel } from "../../components/Page";
import { formatDuration } from "../../lib/format";
import { useToast } from "../../lib/toast";
import type { RouterInputs, RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	listText,
	type RUNPOD_CLOUDS,
	RUNPOD_CPU_FLAVORS,
	splitList,
	toggleChoice,
} from "../runpod/policyDrafts";
import {
	VerificationBuilder,
	type VerificationPlan,
	verificationError,
} from "../tasks/DodBuilder";
import { Setting, Toggle } from "./controls";
import { ModelPicker, ProviderPicker, ProvidersLink } from "./ProviderPicker";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Per-project settings form (`settings.get` / `settings.update`), modelled on
 * `TaskPage`: `draft`/`base` pair, `dirty` by JSON compare, re-sync only while
 * clean, saved only via the sticky bar. Numbers are held as strings (parsing
 * per keystroke turns an empty field into `0`).
 */

type SettingsView = RouterOutputs["settings"]["get"];
type SettingsPatch = RouterInputs["settings"]["update"]["patch"];
type Notify = NonNullable<SettingsView["values"]["notify"]>;
type ProjectRunPodPolicy = NonNullable<SettingsPatch["runpod"]>;
type RunPodPlacement = NonNullable<SettingsPatch["runpodTarget"]>;

export interface ProjectRunPodPolicyDraft {
	restrictGpuTypes: boolean;
	allowedGpuTypes: string;
	restrictCpuFlavors: boolean;
	allowedCpuFlavors: string[];
	restrictImages: boolean;
	allowedImages: string;
	restrictClouds: boolean;
	allowedClouds: string[];
	maxHourlyPrice: string;
	maxGpuCount: string;
	maxConcurrentPods: string;
	maxRuntimeMinutes: string;
	maxRunSpend: string;
}

export interface RunPodPlacementDraft {
	configured: boolean;
	computeType: "CPU" | "GPU";
	image: string;
	cloud: "SECURE" | "COMMUNITY";
	maxHourlyPrice: string;
	maxRuntimeMinutes: string;
	maxSpend: string;
	containerDiskInGb: string;
	volumeInGb: string;
	cpuFlavorId: (typeof RUNPOD_CPU_FLAVORS)[number];
	vcpuCount: string;
	memoryInGb: string;
	gpuTypeId: string;
	gpuCount: string;
	minVcpuPerGpu: string;
	minRamPerGpu: string;
	allowedCudaVersions: string;
}

interface Draft {
	maxConcurrent: string;
	assistance: SettingsView["values"]["assistance"];
	selfRepairMainRed: boolean;
	pushOnMerge: boolean;
	providerId: string;
	model: string;
	modelTierLight: string;
	modelTierStandard: string;
	modelTierStrong: string;
	reviewModel: string;
	reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	approvalMode: "autonomous" | "interactive";
	maxRepairs: string;
	maxStalls: string;
	maxResumes: string;
	leaseMs: string;
	checkPrefix: string;
	mergeChecks: VerificationPlan | null;
	notifyEnabled: boolean;
	notifyWebhook: string;
	notifyCommand: string;
	notifyTimeoutMs: string;
	runpodEnabled: boolean;
	runpodPolicy: ProjectRunPodPolicyDraft;
	runpodTarget: RunPodPlacementDraft;
}

export interface ProjectRunPodDraftSettings {
	runpodEnabled: boolean;
	runpodPolicy: ProjectRunPodPolicyDraft;
	runpodTarget: RunPodPlacementDraft;
}

export function projectPolicyDraft(
	policy: SettingsView["values"]["runpod"],
): ProjectRunPodPolicyDraft {
	return {
		restrictGpuTypes: policy?.allowedGpuTypes !== undefined,
		allowedGpuTypes: listText(policy?.allowedGpuTypes),
		restrictCpuFlavors: policy?.allowedCpuFlavors !== undefined,
		allowedCpuFlavors: [...(policy?.allowedCpuFlavors ?? [])],
		restrictImages: policy?.allowedImages !== undefined,
		allowedImages: listText(policy?.allowedImages),
		restrictClouds: policy?.allowedClouds !== undefined,
		allowedClouds: [...(policy?.allowedClouds ?? [])],
		maxHourlyPrice: policy?.maxHourlyPrice?.toString() ?? "",
		maxGpuCount: policy?.maxGpuCount?.toString() ?? "",
		maxConcurrentPods: policy?.maxConcurrentPods?.toString() ?? "",
		maxRuntimeMinutes: policy?.maxRuntimeMinutes?.toString() ?? "",
		maxRunSpend: policy?.maxRunSpend?.toString() ?? "",
	};
}

export function placementDraft(
	target: SettingsView["values"]["runpodTarget"],
): RunPodPlacementDraft {
	const common = {
		configured: target !== null,
		image: target?.image ?? "",
		cloud: target?.cloud ?? ("SECURE" as const),
		maxHourlyPrice: target?.maxHourlyPrice?.toString() ?? "0.25",
		maxRuntimeMinutes: target?.maxRuntimeMinutes?.toString() ?? "120",
		maxSpend: target?.maxSpend?.toString() ?? "0.50",
		containerDiskInGb: target?.containerDiskInGb?.toString() ?? "50",
		volumeInGb: target?.volumeInGb?.toString() ?? "0",
	};
	if (target?.computeType === "GPU") {
		return {
			...common,
			computeType: "GPU",
			cpuFlavorId: "cpu3m",
			vcpuCount: "2",
			memoryInGb: "16",
			gpuTypeId: target.gpuTypeId,
			gpuCount: target.gpuCount.toString(),
			minVcpuPerGpu: target.minVcpuPerGpu?.toString() ?? "",
			minRamPerGpu: target.minRamPerGpu?.toString() ?? "",
			allowedCudaVersions: listText(target.allowedCudaVersions),
		};
	}
	return {
		...common,
		computeType: "CPU",
		cpuFlavorId: target?.cpuFlavorId ?? "cpu3m",
		vcpuCount: target?.vcpuCount?.toString() ?? "2",
		memoryInGb: target?.memoryInGb?.toString() ?? "16",
		gpuTypeId: "",
		gpuCount: "1",
		minVcpuPerGpu: "",
		minRamPerGpu: "",
		allowedCudaVersions: "",
	};
}

function toDraft(values: SettingsView["values"]): Draft {
	return {
		maxConcurrent: String(values.maxConcurrent),
		assistance: values.assistance,
		selfRepairMainRed: values.selfRepairMainRed,
		pushOnMerge: values.pushOnMerge,
		providerId: values.provider.id,
		model: values.model,
		modelTierLight: values.modelTiers?.light ?? "",
		modelTierStandard: values.modelTiers?.standard ?? "",
		modelTierStrong: values.modelTiers?.strong ?? "",
		reviewModel: values.reviewModel ?? "",
		reasoningEffort: values.reasoningEffort,
		approvalMode: values.approvalMode,
		maxRepairs: String(values.maxRepairs),
		maxStalls: String(values.maxStalls),
		maxResumes: String(values.maxResumes),
		leaseMs: String(values.leaseMs),
		checkPrefix: values.checkPrefix ?? "",
		mergeChecks: values.mergeChecks ?? null,
		notifyEnabled: values.notify !== null,
		notifyWebhook: values.notify?.webhook ?? "",
		notifyCommand: values.notify?.command ?? "",
		notifyTimeoutMs:
			values.notify?.timeoutMs === undefined
				? ""
				: String(values.notify.timeoutMs),
		runpodEnabled: values.runpod?.enabled === true,
		runpodPolicy: projectPolicyDraft(values.runpod),
		runpodTarget: placementDraft(values.runpodTarget),
	};
}

/** Only tiers with text go on the wire; all three blank means "unset". */
function modelTiersOf(draft: Draft): SettingsPatch["modelTiers"] {
	const light = draft.modelTierLight.trim();
	const standard = draft.modelTierStandard.trim();
	const strong = draft.modelTierStrong.trim();
	if (!light && !standard && !strong) return null;
	return {
		...(light ? { light } : {}),
		...(standard ? { standard } : {}),
		...(strong ? { strong } : {}),
	};
}

/** `undefined` for a blank field: the server treats an absent key as "unset", not as an empty string. */
function notifyOf(draft: Draft): Notify | null {
	if (!draft.notifyEnabled) return null;
	const timeoutMs = Number(draft.notifyTimeoutMs);
	return {
		webhook: draft.notifyWebhook.trim() || undefined,
		command: draft.notifyCommand.trim() || undefined,
		timeoutMs:
			draft.notifyTimeoutMs.trim() === "" || !Number.isFinite(timeoutMs)
				? undefined
				: timeoutMs,
	};
}

const NUMBER_LIMITS: Record<
	string,
	{ label: string; min: number; max?: number }
> = {
	maxConcurrent: { label: "Maximum parallel agents", min: 1, max: 64 },
	maxRepairs: { label: "Maximum repair attempts", min: 0, max: 20 },
	maxStalls: { label: "Maximum stalled turns", min: 1, max: 20 },
	maxResumes: { label: "Maximum resume attempts", min: 0, max: 20 },
	leaseMs: { label: "Run lease duration", min: 1000 },
};

function optionalNumber(
	value: string,
	label: string,
	options: { whole?: boolean; minimum?: number } = {},
): number | undefined {
	if (!value.trim()) return undefined;
	const parsed = Number(value);
	if (
		!Number.isFinite(parsed) ||
		(options.whole === true && !Number.isInteger(parsed)) ||
		parsed < (options.minimum ?? Number.MIN_VALUE)
	) {
		throw new Error(
			`${label} must be ${options.whole ? "a whole number" : "a number"}${options.minimum !== undefined ? ` of at least ${options.minimum}` : " greater than zero"}`,
		);
	}
	return parsed;
}

export function projectPolicyInput(
	draft: ProjectRunPodPolicyDraft,
): ProjectRunPodPolicy {
	const allowedGpuTypes = splitList(draft.allowedGpuTypes);
	const allowedImages = splitList(draft.allowedImages);
	return {
		enabled: true,
		...(draft.restrictGpuTypes ? { allowedGpuTypes } : {}),
		...(draft.restrictCpuFlavors
			? {
					allowedCpuFlavors: draft.allowedCpuFlavors as Array<
						(typeof RUNPOD_CPU_FLAVORS)[number]
					>,
				}
			: {}),
		...(draft.restrictImages ? { allowedImages } : {}),
		...(draft.restrictClouds
			? {
					allowedClouds: draft.allowedClouds as Array<
						(typeof RUNPOD_CLOUDS)[number]
					>,
				}
			: {}),
		maxHourlyPrice: optionalNumber(
			draft.maxHourlyPrice,
			"Project hourly ceiling",
			{ minimum: Number.MIN_VALUE },
		),
		maxGpuCount: optionalNumber(draft.maxGpuCount, "Project GPU ceiling", {
			whole: true,
			minimum: 0,
		}),
		maxConcurrentPods: optionalNumber(
			draft.maxConcurrentPods,
			"Project concurrent Pod ceiling",
			{ whole: true, minimum: 1 },
		),
		maxRuntimeMinutes: optionalNumber(
			draft.maxRuntimeMinutes,
			"Project runtime ceiling",
			{ whole: true, minimum: 1 },
		),
		maxRunSpend: optionalNumber(draft.maxRunSpend, "Project spend ceiling", {
			minimum: Number.MIN_VALUE,
		}),
	};
}

function requiredNumber(
	value: string,
	label: string,
	options: { whole?: boolean; minimum?: number } = {},
): number {
	const parsed = optionalNumber(value, label, options);
	if (parsed === undefined) throw new Error(`${label} is required`);
	return parsed;
}

export function placementInput(draft: RunPodPlacementDraft): RunPodPlacement {
	if (!draft.image.trim())
		throw new Error("Default container image is required");
	const common = {
		image: draft.image.trim(),
		cloud: draft.cloud,
		maxHourlyPrice: requiredNumber(draft.maxHourlyPrice, "Task hourly ceiling"),
		maxRuntimeMinutes: requiredNumber(
			draft.maxRuntimeMinutes,
			"Task runtime ceiling",
			{ whole: true, minimum: 1 },
		),
		maxSpend: requiredNumber(draft.maxSpend, "Task spend ceiling"),
		containerDiskInGb: requiredNumber(
			draft.containerDiskInGb,
			"Container disk",
			{ whole: true, minimum: 1 },
		),
		volumeInGb: requiredNumber(draft.volumeInGb, "Persistent volume", {
			whole: true,
			minimum: 0,
		}),
	};
	if (common.containerDiskInGb > 10_000)
		throw new Error("Container disk must be at most 10000 GB");
	if (common.volumeInGb > 100_000)
		throw new Error("Persistent volume must be at most 100000 GB");
	if (draft.computeType === "CPU") {
		return {
			...common,
			computeType: "CPU",
			cpuFlavorId: draft.cpuFlavorId,
			vcpuCount: requiredNumber(draft.vcpuCount, "vCPU count", {
				whole: true,
				minimum: 1,
			}),
			memoryInGb: requiredNumber(draft.memoryInGb, "Memory", {
				whole: true,
				minimum: 1,
			}),
		};
	}
	if (!draft.gpuTypeId.trim())
		throw new Error("Default GPU type ID is required");
	const allowedCudaVersions = splitList(draft.allowedCudaVersions);
	if (allowedCudaVersions.length > 32)
		throw new Error("Allowed CUDA versions may contain at most 32 entries");
	return {
		...common,
		computeType: "GPU",
		gpuTypeId: draft.gpuTypeId.trim(),
		gpuCount: requiredNumber(draft.gpuCount, "GPU count", {
			whole: true,
			minimum: 1,
		}),
		minVcpuPerGpu: optionalNumber(draft.minVcpuPerGpu, "Minimum vCPU per GPU", {
			whole: true,
			minimum: 1,
		}),
		minRamPerGpu: optionalNumber(draft.minRamPerGpu, "Minimum RAM per GPU", {
			whole: true,
			minimum: 1,
		}),
		allowedCudaVersions,
	};
}

/**
 * Builds only the changed project RunPod keys. Disabling writes `enabled: false`
 * with limits retained and omits placement, so the saved default survives re-enabling.
 */
export function projectRunPodPatch(
	draft: ProjectRunPodDraftSettings,
	base: ProjectRunPodDraftSettings,
): Pick<SettingsPatch, "runpod" | "runpodTarget"> {
	const patch: Pick<SettingsPatch, "runpod" | "runpodTarget"> = {};
	if (
		draft.runpodEnabled !== base.runpodEnabled ||
		JSON.stringify(draft.runpodPolicy) !== JSON.stringify(base.runpodPolicy)
	) {
		patch.runpod = {
			...projectPolicyInput(draft.runpodPolicy),
			enabled: draft.runpodEnabled,
		};
	}
	if (
		draft.runpodEnabled &&
		draft.runpodTarget.configured &&
		(draft.runpodEnabled !== base.runpodEnabled ||
			JSON.stringify(draft.runpodTarget) !== JSON.stringify(base.runpodTarget))
	) {
		patch.runpodTarget = placementInput(draft.runpodTarget);
	}
	return patch;
}

/** One sentence naming the first thing the server would reject, or null. */
function validate(draft: Draft): string | null {
	for (const [key, limit] of Object.entries(NUMBER_LIMITS)) {
		const raw = draft[key as keyof Draft] as string;
		const n = Number(raw);
		if (raw.trim() === "" || !Number.isInteger(n)) {
			return `${limit.label} must be a whole number`;
		}
		if (n < limit.min) return `${limit.label} must be at least ${limit.min}`;
		if (limit.max !== undefined && n > limit.max) {
			return `${limit.label} must be at most ${limit.max}`;
		}
	}
	if (draft.providerId.trim() === "") return "pick an agent CLI";
	if (draft.model.trim() === "") return "model cannot be empty";
	const dodProblem = verificationError(draft.mergeChecks);
	if (dodProblem) return dodProblem;
	if (draft.notifyEnabled) {
		const webhook = draft.notifyWebhook.trim();
		if (webhook !== "") {
			try {
				new URL(webhook);
			} catch {
				return "the webhook must be an absolute URL";
			}
		}
		if (webhook === "" && draft.notifyCommand.trim() === "") {
			return "notifications need a webhook or a command";
		}
		const timeout = Number(draft.notifyTimeoutMs);
		if (
			draft.notifyTimeoutMs.trim() !== "" &&
			(!Number.isInteger(timeout) || timeout <= 0)
		) {
			return "the notify timeout must be a positive whole number of ms";
		}
	}
	try {
		projectPolicyInput(draft.runpodPolicy);
		if (draft.runpodEnabled && draft.runpodTarget.configured) {
			placementInput(draft.runpodTarget);
		}
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return null;
}

/** Only changed keys: sending everything would pin the daemon's running defaults into config. */
function diffPatch(draft: Draft, base: Draft): SettingsPatch {
	const patch: SettingsPatch = {};
	if (draft.maxConcurrent !== base.maxConcurrent) {
		patch.maxConcurrent = Number(draft.maxConcurrent);
	}
	if (JSON.stringify(draft.assistance) !== JSON.stringify(base.assistance)) {
		patch.assistance = draft.assistance;
	}
	if (draft.selfRepairMainRed !== base.selfRepairMainRed) {
		patch.selfRepairMainRed = draft.selfRepairMainRed;
	}
	if (draft.pushOnMerge !== base.pushOnMerge) {
		patch.pushOnMerge = draft.pushOnMerge;
	}
	// `env` is absent: this form has no editor for it, and omitting `provider`
	// while unchanged preserves any env set by hand in config.json.
	if (draft.providerId !== base.providerId) {
		patch.provider = { id: draft.providerId };
	}
	if (draft.model !== base.model) patch.model = draft.model.trim();
	const modelTiers = modelTiersOf(draft);
	if (JSON.stringify(modelTiers) !== JSON.stringify(modelTiersOf(base))) {
		patch.modelTiers = modelTiers;
	}
	if (draft.reviewModel !== base.reviewModel) {
		patch.reviewModel = draft.reviewModel.trim() || null;
	}
	if (draft.reasoningEffort !== base.reasoningEffort) {
		patch.reasoningEffort = draft.reasoningEffort;
	}
	if (draft.approvalMode !== base.approvalMode) {
		patch.approvalMode = draft.approvalMode;
	}
	if (draft.maxRepairs !== base.maxRepairs) {
		patch.maxRepairs = Number(draft.maxRepairs);
	}
	if (draft.maxStalls !== base.maxStalls) {
		patch.maxStalls = Number(draft.maxStalls);
	}
	if (draft.maxResumes !== base.maxResumes) {
		patch.maxResumes = Number(draft.maxResumes);
	}
	if (draft.leaseMs !== base.leaseMs) patch.leaseMs = Number(draft.leaseMs);
	if (draft.checkPrefix !== base.checkPrefix) {
		patch.checkPrefix = draft.checkPrefix.trim() || null;
	}
	if (JSON.stringify(draft.mergeChecks) !== JSON.stringify(base.mergeChecks)) {
		patch.mergeChecks = draft.mergeChecks;
	}
	const notify = notifyOf(draft);
	if (JSON.stringify(notify) !== JSON.stringify(notifyOf(base))) {
		patch.notify = notify;
	}
	Object.assign(patch, projectRunPodPatch(draft, base));
	return patch;
}

/** Which of the pending changes the running daemon will not pick up. */
function pendingRestartKeys(
	patch: SettingsPatch,
	needsRestart: readonly string[],
): string[] {
	return Object.keys(patch).filter((key) => needsRestart.includes(key));
}

export function ProjectConfig({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const settings = useQuery(trpc.settings.get.queryOptions({ project }));
	const runpodAccount = useQuery(trpc.runpod.get.queryOptions());
	const catalogue = useQuery(trpc.settings.providers.catalogue.queryOptions());
	const view = settings.data ?? null;

	const [draft, setDraft] = useState<Draft | null>(null);
	const [base, setBase] = useState<Draft | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [runpodAdvancedOpen, setRunpodAdvancedOpen] = useState(false);

	const dirty = useMemo(
		() =>
			draft !== null && base !== null
				? JSON.stringify(draft) !== JSON.stringify(base)
				: false,
		[draft, base],
	);
	useBlocker({
		disabled: !dirty,
		enableBeforeUnload: dirty,
		shouldBlockFn: () =>
			!window.confirm("Discard the unsaved project settings?"),
	});

	// Adopt the server's copy only while clean, so a refetch never overwrites
	// edits; the equality guard stops it re-running on its own state write.
	useEffect(() => {
		if (!view || dirty) return;
		const next = toDraft(view.values);
		if (draft !== null && JSON.stringify(draft) === JSON.stringify(next))
			return;
		setDraft(next);
		setBase(next);
	}, [view, draft, dirty]);

	const save = useMutation(
		trpc.settings.update.mutationOptions({
			meta: { label: "Save settings" },
			onMutate: () => setSaveError(null),
			onSuccess: (updated) => {
				const next = toDraft(updated.values);
				setDraft(next);
				setBase(next);
				setSaveError(null);
				toast({ tone: "success", title: `${project} settings saved` });
			},
			onError: (error) => setSaveError(errorText(error)),
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.settings.get.queryFilter({ project }),
				);
			},
		}),
	);

	if (settings.error) {
		return (
			<Panel title="Project configuration">
				<ErrorState
					title="Could not read this project's settings"
					error={settings.error}
					onRetry={() => void settings.refetch()}
				/>
			</Panel>
		);
	}

	if (!view || !draft || !base) {
		return (
			<Panel title="Project configuration">
				<LoadingRows rows={8} />
			</Panel>
		);
	}

	const needsRestart: readonly string[] = view.needsRestart;
	const restart = (key: string) => needsRestart.includes(key);
	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
		setSaveError(null);
		setDraft({ ...draft, [key]: value });
	};
	// Light/strong inherit catalogue tiers; standard inherits the project model.
	const providerTiers = catalogue.data?.providers.find(
		(p) => p.id === draft.providerId,
	)?.tiers;
	const providerImageSet = new Set<string>([
		MFW_RUNPOD_CPU_RUNTIME.image,
		...(runpodAccount.data?.pods ?? []).flatMap((pod) =>
			pod.actualShape.image ? [pod.actualShape.image] : [],
		),
	]);
	if (draft.runpodTarget.configured && draft.runpodTarget.image) {
		providerImageSet.add(draft.runpodTarget.image);
	}
	const providerImages = [...providerImageSet];
	const providerGpuTypeSet = new Set(
		(runpodAccount.data?.pods ?? []).flatMap((pod) =>
			pod.actualShape.computeType === "GPU" && pod.actualShape.offeringId
				? [pod.actualShape.offeringId]
				: [],
		),
	);
	if (draft.runpodTarget.configured && draft.runpodTarget.gpuTypeId) {
		providerGpuTypeSet.add(draft.runpodTarget.gpuTypeId);
	}
	const providerGpuTypes = [...providerGpuTypeSet];
	const providerCpuFlavorSet = new Set<(typeof RUNPOD_CPU_FLAVORS)[number]>([
		MFW_RUNPOD_CPU_RUNTIME.cpuFlavorId,
		...(runpodAccount.data?.pods ?? []).flatMap((pod) => {
			const offering = pod.actualShape.offeringId;
			return pod.actualShape.computeType === "CPU" &&
				offering &&
				(RUNPOD_CPU_FLAVORS as readonly string[]).includes(offering)
				? [offering as (typeof RUNPOD_CPU_FLAVORS)[number]]
				: [];
		}),
	]);
	if (
		draft.runpodTarget.configured &&
		draft.runpodTarget.computeType === "CPU"
	) {
		providerCpuFlavorSet.add(draft.runpodTarget.cpuFlavorId);
	}
	const providerCpuFlavors = [...providerCpuFlavorSet];
	const hasPlacementCatalogue =
		providerImages.length > 0 &&
		(providerCpuFlavors.length > 0 || providerGpuTypes.length > 0);

	const problem = validate(draft);
	const patch = problem ? {} : diffPatch(draft, base);
	const pending = pendingRestartKeys(patch, needsRestart);

	return (
		<>
			{/* Identity fields are read-only: changing a root at runtime would orphan its worktrees, runs and database. */}
			<div
				className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<span>
					Repository <Mono value={view.root} />
				</span>
				<span>
					Merge branch <Mono value={view.integrationBranch} />
				</span>
			</div>

			<Panel title="Dispatch">
				<div className="flex flex-col gap-3">
					<Setting
						label="Maximum parallel agents"
						restart={restart("maxConcurrent")}
						hint="Hard ceiling (1-64). The brain chooses each wave from dependency-ready tasks; resource locks and admission may narrow it further."
					>
						<Input
							type="number"
							min={1}
							max={64}
							className="max-w-32"
							aria-label="Maximum parallel agents"
							value={draft.maxConcurrent}
							onChange={(e) => set("maxConcurrent", e.target.value)}
						/>
					</Setting>
					<Setting
						label="Ambiguous failures"
						restart={restart("assistance")}
						hint="Choose whether AI should investigate failures that checks cannot explain."
					>
						<Select
							value={draft.assistance.failureDiagnosis}
							onValueChange={(value) =>
								set("assistance", {
									...draft.assistance,
									failureDiagnosis: value as "assisted" | "escalate",
								})
							}
						>
							<SelectTrigger
								className="min-w-52"
								aria-label="Ambiguous failure policy"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="assisted">
									Model-assisted diagnosis
								</SelectItem>
								<SelectItem value="escalate">
									Escalate without guessing
								</SelectItem>
							</SelectContent>
						</Select>
					</Setting>
					<Setting
						label="Merge conflicts"
						restart={restart("assistance")}
						hint="Standard retries run first. After that, either ask AI for help or stop for review."
					>
						<Select
							value={draft.assistance.conflictResolution}
							onValueChange={(value) =>
								set("assistance", {
									...draft.assistance,
									conflictResolution: value as "assisted" | "escalate",
								})
							}
						>
							<SelectTrigger
								className="min-w-52"
								aria-label="Merge conflict policy"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="assisted">
									Attempt assisted resolution
								</SelectItem>
								<SelectItem value="escalate">Escalate after retries</SelectItem>
							</SelectContent>
						</Select>
					</Setting>
					<Setting
						label="Change review"
						restart={restart("assistance")}
						hint="Off reviews only tasks that explicitly request it. Assisted review checks the goal and criteria. Human review sends every change to Review."
					>
						<Select
							value={draft.assistance.changeReview}
							onValueChange={(value) =>
								set("assistance", {
									...draft.assistance,
									changeReview: value as "off" | "assisted" | "human",
								})
							}
						>
							<SelectTrigger
								className="min-w-52"
								aria-label="Change review policy"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="off">Only when requested</SelectItem>
								<SelectItem value="assisted">Assisted acceptance</SelectItem>
								<SelectItem value="human">Human acceptance</SelectItem>
							</SelectContent>
						</Select>
					</Setting>
					<Toggle
						label="Repair broken main automatically"
						restart={restart("selfRepairMainRed")}
						hint="Allows the task that broke main to retry while other work remains paused. Stops after repeated failures."
						checked={draft.selfRepairMainRed}
						onChange={(v) => set("selfRepairMainRed", v)}
					/>
					<Toggle
						label="Push after merging"
						restart={restart("pushOnMerge")}
						hint="Pushes the merge branch to its remote after each merge. A failed push does not undo the merge."
						checked={draft.pushOnMerge}
						onChange={(v) => set("pushOnMerge", v)}
					/>
				</div>
			</Panel>

			<Panel title="Agent">
				<div className="flex flex-col gap-3">
					<Setting
						label="agent CLI"
						restart={restart("provider")}
						hint="Provider used for new runs. Existing runs keep their current provider."
					>
						<ProviderPicker
							value={draft.providerId}
							onChange={(id, defaultModel) =>
								setDraft({
									...draft,
									providerId: id,
									model: defaultModel,
									reasoningEffort: "medium",
								})
							}
						/>
					</Setting>
					<Setting label="model" restart={restart("model")}>
						<ModelPicker
							providerId={draft.providerId}
							value={draft.model}
							onChange={(model) => set("model", model)}
						/>
					</Setting>
					<div className="grid gap-3 sm:grid-cols-3">
						<Setting
							label="light tier model"
							restart={restart("modelTiers")}
							hint="Model for tasks whose model_tier is light. Blank uses the provider's default for the tier."
						>
							<Input
								className="max-w-56"
								aria-label="Light tier model"
								autoComplete="off"
								placeholder={providerTiers?.light ?? "provider default"}
								value={draft.modelTierLight}
								onChange={(e) => set("modelTierLight", e.target.value)}
							/>
						</Setting>
						<Setting
							label="standard tier model"
							restart={restart("modelTiers")}
							hint="Model for tasks whose model_tier is standard. Blank uses the project model selected above."
						>
							<Input
								className="max-w-56"
								aria-label="Standard tier model"
								autoComplete="off"
								placeholder={draft.model || "project model"}
								value={draft.modelTierStandard}
								onChange={(e) => set("modelTierStandard", e.target.value)}
							/>
						</Setting>
						<Setting
							label="strong tier model"
							restart={restart("modelTiers")}
							hint="Model for tasks whose model_tier is strong. Blank uses the provider's default for the tier."
						>
							<Input
								className="max-w-56"
								aria-label="Strong tier model"
								autoComplete="off"
								placeholder={providerTiers?.strong ?? "provider default"}
								value={draft.modelTierStrong}
								onChange={(e) => set("modelTierStrong", e.target.value)}
							/>
						</Setting>
					</div>
					<Setting
						label="review model"
						restart={restart("reviewModel")}
						hint="Model used for the semantic change review (critic). Blank uses the brain's own model."
					>
						<Input
							className="max-w-56"
							aria-label="Review model"
							autoComplete="off"
							placeholder="brain default"
							value={draft.reviewModel}
							onChange={(e) => set("reviewModel", e.target.value)}
						/>
					</Setting>
					{draft.providerId === "codex-cli" ? (
						<Setting
							label="reasoning effort"
							restart={restart("reasoningEffort")}
							hint="Controls how much reasoning Codex uses for each turn. Medium is the balanced default."
						>
							<Select
								value={draft.reasoningEffort}
								onValueChange={(value) =>
									set("reasoningEffort", value as Draft["reasoningEffort"])
								}
							>
								<SelectTrigger
									aria-label="Reasoning effort"
									className="min-w-40"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper">
									<SelectItem value="none">None</SelectItem>
									<SelectItem value="low">Low</SelectItem>
									<SelectItem value="medium">Medium</SelectItem>
									<SelectItem value="high">High</SelectItem>
									<SelectItem value="xhigh">Extra high</SelectItem>
									<SelectItem value="max">Max</SelectItem>
								</SelectContent>
							</Select>
						</Setting>
					) : null}
					<Setting
						label="approval mode"
						restart={restart("approvalMode")}
						hint="Autonomous runs use the configured sandbox policy without pausing. Interactive runs surface provider approval requests for an operator decision."
					>
						<Select
							value={draft.approvalMode}
							onValueChange={(value) =>
								set("approvalMode", value as Draft["approvalMode"])
							}
						>
							<SelectTrigger aria-label="Approval mode" className="min-w-52">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="autonomous">Autonomous</SelectItem>
								<SelectItem value="interactive">
									Interactive approvals
								</SelectItem>
							</SelectContent>
						</Select>
					</Setting>
					<ProvidersLink />
				</div>
			</Panel>

			<Panel title="Runs">
				<div className="grid gap-3 sm:grid-cols-2">
					<Setting
						label="claim timeout"
						restart={restart("leaseMs")}
						hint={`${formatDuration(Number(draft.leaseMs) || 0)}: how long an inactive run may hold a task before it is released.`}
					>
						<Input
							type="number"
							min={1000}
							step={1000}
							aria-label="Lease in milliseconds"
							value={draft.leaseMs}
							onChange={(e) => set("leaseMs", e.target.value)}
						/>
					</Setting>
					<Setting
						label="max repairs"
						restart={restart("maxRepairs")}
						hint="Repair attempts after a failed check before the task is parked (0-20)."
					>
						<Input
							type="number"
							min={0}
							max={20}
							aria-label="Max repairs"
							value={draft.maxRepairs}
							onChange={(e) => set("maxRepairs", e.target.value)}
						/>
					</Setting>
					<Setting
						label="max stalls"
						restart={restart("maxStalls")}
						hint="Consecutive stalled passes tolerated before a run is abandoned (1-20)."
					>
						<Input
							type="number"
							min={1}
							max={20}
							aria-label="Max stalls"
							value={draft.maxStalls}
							onChange={(e) => set("maxStalls", e.target.value)}
						/>
					</Setting>
					<Setting
						label="max resumes"
						restart={restart("maxResumes")}
						hint="Times an interrupted run may be resumed (0-20)."
					>
						<Input
							type="number"
							min={0}
							max={20}
							aria-label="Max resumes"
							value={draft.maxResumes}
							onChange={(e) => set("maxResumes", e.target.value)}
						/>
					</Setting>
					<Setting
						label="check prefix"
						restart={restart("checkPrefix")}
						hint="Prepended to every project and task verification command. Empty means none."
					>
						<Input
							aria-label="Check prefix"
							placeholder="bun run"
							value={draft.checkPrefix}
							onChange={(e) => set("checkPrefix", e.target.value)}
						/>
					</Setting>
				</div>
				<Setting
					label="required checks"
					restart={restart("mergeChecks")}
					hint="Checks every change must pass before merging. Task-specific checks can add more."
				>
					<VerificationBuilder
						value={draft.mergeChecks}
						taskType="task"
						onChange={(next) => set("mergeChecks", next)}
					/>
				</Setting>
			</Panel>

			<Panel title="Remote execution">
				<div className="flex flex-col gap-3">
					<Toggle
						label="Allow RunPod tasks in this project"
						restart={restart("runpod")}
						hint="Off by default. Provider choices are unrestricted unless you add a project restriction below; machine cost guardrails always apply."
						checked={draft.runpodEnabled}
						onChange={(value) => set("runpodEnabled", value)}
					/>
					{draft.runpodEnabled ? (
						<>
							<section className="flex flex-col gap-3 border p-3">
								<div>
									<h3>Project cost guardrails</h3>
									<p style={{ color: "var(--mfw-fg-muted)" }}>
										Leave a value blank to inherit the machine limit. Projects
										can only lower these limits.
									</p>
								</div>
								<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
									{(
										[
											["Maximum $/hr", "maxHourlyPrice"],
											["Runtime minutes", "maxRuntimeMinutes"],
											["Maximum spend $", "maxRunSpend"],
										] as Array<
											[
												string,
												"maxHourlyPrice" | "maxRuntimeMinutes" | "maxRunSpend",
											]
										>
									).map(([label, key]) => (
										<Setting
											key={key}
											label={label}
											restart={restart("runpod")}
										>
											<Input
												aria-label={`Project RunPod ${label}`}
												placeholder="Inherit"
												value={draft.runpodPolicy[key]}
												onChange={(event) =>
													set("runpodPolicy", {
														...draft.runpodPolicy,
														[key]: event.target.value,
													})
												}
											/>
										</Setting>
									))}
								</div>
							</section>

							{hasPlacementCatalogue ? (
								<section className="flex flex-col gap-3 border p-3">
									<div>
										<h3>Default placement</h3>
										<p style={{ color: "var(--mfw-fg-muted)" }}>
											Choose an MFW-managed runner or a provider placement MFW
											has actually observed.
										</p>
									</div>
									<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
										<Setting label="Compute" restart={restart("runpodTarget")}>
											<Select
												value={
													draft.runpodTarget.computeType === "CPU" &&
													providerCpuFlavors.length > 0
														? "CPU"
														: draft.runpodTarget.computeType === "GPU" &&
																providerGpuTypes.length > 0
															? "GPU"
															: ""
												}
												onValueChange={(value) =>
													set("runpodTarget", {
														...draft.runpodTarget,
														configured: Boolean(draft.runpodTarget.image),
														computeType: value as "CPU" | "GPU",
														cpuFlavorId:
															providerCpuFlavors[0] ??
															draft.runpodTarget.cpuFlavorId,
														gpuTypeId:
															providerGpuTypes[0] ??
															draft.runpodTarget.gpuTypeId,
													})
												}
											>
												<SelectTrigger aria-label="Default RunPod compute">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{providerCpuFlavors.length > 0 ? (
														<SelectItem value="CPU">CPU</SelectItem>
													) : null}
													{providerGpuTypes.length > 0 ? (
														<SelectItem value="GPU">GPU</SelectItem>
													) : null}
												</SelectContent>
											</Select>
										</Setting>
										<Setting label="Cloud" restart={restart("runpodTarget")}>
											<Select
												value={draft.runpodTarget.cloud}
												onValueChange={(value) =>
													set("runpodTarget", {
														...draft.runpodTarget,
														configured: true,
														cloud: value as "SECURE" | "COMMUNITY",
													})
												}
											>
												<SelectTrigger aria-label="Default RunPod cloud">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="SECURE">Secure Cloud</SelectItem>
													<SelectItem value="COMMUNITY">
														Community Cloud
													</SelectItem>
												</SelectContent>
											</Select>
										</Setting>
										<Setting label="Image" restart={restart("runpodTarget")}>
											<Select
												value={draft.runpodTarget.image}
												onValueChange={(image) =>
													set("runpodTarget", {
														...draft.runpodTarget,
														configured: Boolean(image),
														image,
														computeType:
															image === MFW_RUNPOD_CPU_RUNTIME.image
																? "CPU"
																: draft.runpodTarget.computeType,
														cpuFlavorId:
															image === MFW_RUNPOD_CPU_RUNTIME.image
																? MFW_RUNPOD_CPU_RUNTIME.cpuFlavorId
																: (providerCpuFlavors[0] ??
																	draft.runpodTarget.cpuFlavorId),
														vcpuCount:
															image === MFW_RUNPOD_CPU_RUNTIME.image
																? String(MFW_RUNPOD_CPU_RUNTIME.vcpuCount)
																: draft.runpodTarget.vcpuCount,
														memoryInGb:
															image === MFW_RUNPOD_CPU_RUNTIME.image
																? String(MFW_RUNPOD_CPU_RUNTIME.memoryInGb)
																: draft.runpodTarget.memoryInGb,
														gpuTypeId:
															providerGpuTypes[0] ??
															draft.runpodTarget.gpuTypeId,
													})
												}
											>
												<SelectTrigger aria-label="Default RunPod image">
													<SelectValue placeholder="Choose a runtime" />
												</SelectTrigger>
												<SelectContent>
													{providerImages.map((image) => (
														<SelectItem key={image} value={image}>
															{runPodImageLabel(image)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</Setting>
										{draft.runpodTarget.computeType === "CPU" &&
										providerCpuFlavors.length > 0 ? (
											<Setting
												label="CPU option"
												restart={restart("runpodTarget")}
											>
												<Select
													value={draft.runpodTarget.cpuFlavorId}
													onValueChange={(cpuFlavorId) =>
														set("runpodTarget", {
															...draft.runpodTarget,
															configured: Boolean(draft.runpodTarget.image),
															cpuFlavorId:
																cpuFlavorId as (typeof RUNPOD_CPU_FLAVORS)[number],
														})
													}
												>
													<SelectTrigger aria-label="Default RunPod CPU option">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{providerCpuFlavors.map((flavor) => (
															<SelectItem key={flavor} value={flavor}>
																{runPodCpuFlavorLabel(flavor)}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</Setting>
										) : null}
										{draft.runpodTarget.computeType === "GPU" &&
										providerGpuTypes.length > 0 ? (
											<Setting label="GPU" restart={restart("runpodTarget")}>
												<Select
													value={draft.runpodTarget.gpuTypeId}
													onValueChange={(gpuTypeId) =>
														set("runpodTarget", {
															...draft.runpodTarget,
															configured: Boolean(draft.runpodTarget.image),
															gpuTypeId,
														})
													}
												>
													<SelectTrigger aria-label="Default RunPod GPU">
														<SelectValue placeholder="Choose from live inventory" />
													</SelectTrigger>
													<SelectContent>
														{providerGpuTypes.map((gpu) => (
															<SelectItem key={gpu} value={gpu}>
																{gpu}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</Setting>
										) : null}
									</div>
								</section>
							) : (
								<p role="status" style={{ color: "var(--mfw-fg-muted)" }}>
									RunPod is ready for this project. Tasks may choose any
									provider placement within the cost guardrails; no default
									placement is required.
								</p>
							)}

							{providerImages.length > 0 || providerGpuTypes.length > 0 ? (
								<section className="flex flex-col gap-3 border p-3">
									<h3>Optional provider restrictions</h3>
									<p style={{ color: "var(--mfw-fg-muted)" }}>
										Only MFW-managed or previously observed choices are offered.
										Leaving these off keeps provider choices unrestricted within
										cost guardrails.
									</p>
									{providerImages.length > 0 ? (
										<Setting label="Allowed images">
											<div className="flex flex-wrap gap-3">
												{providerImages.map((image) => (
													<Toggle
														key={image}
														label={runPodImageLabel(image)}
														checked={
															!draft.runpodPolicy.restrictImages ||
															splitList(
																draft.runpodPolicy.allowedImages,
															).includes(image)
														}
														onChange={() => {
															const current = draft.runpodPolicy.restrictImages
																? splitList(draft.runpodPolicy.allowedImages)
																: [...providerImages];
															const next = toggleChoice(current, image);
															set("runpodPolicy", {
																...draft.runpodPolicy,
																restrictImages:
																	next.length !== providerImages.length,
																allowedImages: next.join("\n"),
															});
														}}
													/>
												))}
											</div>
										</Setting>
									) : null}
									{providerGpuTypes.length > 0 ? (
										<Setting label="Allowed GPUs">
											<div className="flex flex-wrap gap-3">
												{providerGpuTypes.map((gpu) => (
													<Toggle
														key={gpu}
														label={gpu}
														checked={
															!draft.runpodPolicy.restrictGpuTypes ||
															splitList(
																draft.runpodPolicy.allowedGpuTypes,
															).includes(gpu)
														}
														onChange={() => {
															const current = draft.runpodPolicy
																.restrictGpuTypes
																? splitList(draft.runpodPolicy.allowedGpuTypes)
																: [...providerGpuTypes];
															const next = toggleChoice(current, gpu);
															set("runpodPolicy", {
																...draft.runpodPolicy,
																restrictGpuTypes:
																	next.length !== providerGpuTypes.length,
																allowedGpuTypes: next.join("\n"),
															});
														}}
													/>
												))}
											</div>
										</Setting>
									) : null}
								</section>
							) : null}

							{hasPlacementCatalogue ? (
								<Panel
									title="Advanced placement details"
									actions={
										<Button
											size="xs"
											variant="ghost"
											aria-expanded={runpodAdvancedOpen}
											onClick={() => setRunpodAdvancedOpen(!runpodAdvancedOpen)}
										>
											{runpodAdvancedOpen ? (
												<ChevronDown aria-hidden />
											) : (
												<ChevronRight aria-hidden />
											)}
											{runpodAdvancedOpen ? "Hide advanced" : "Show advanced"}
										</Button>
									}
								>
									{runpodAdvancedOpen && draft.runpodTarget.configured ? (
										<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
											{(
												[
													["Task maximum $/hr", "maxHourlyPrice"],
													["Runtime minutes", "maxRuntimeMinutes"],
													["Task maximum spend $", "maxSpend"],
													["Container disk GB", "containerDiskInGb"],
													["Persistent volume GB", "volumeInGb"],
												] as Array<
													[
														string,
														(
															| "maxHourlyPrice"
															| "maxRuntimeMinutes"
															| "maxSpend"
															| "containerDiskInGb"
															| "volumeInGb"
														),
													]
												>
											).map(([label, key]) => (
												<Setting key={key} label={label}>
													<Input
														aria-label={`Default RunPod ${label}`}
														value={draft.runpodTarget[key]}
														onChange={(event) =>
															set("runpodTarget", {
																...draft.runpodTarget,
																[key]: event.target.value,
															})
														}
													/>
												</Setting>
											))}
										</div>
									) : (
										<p style={{ color: "var(--mfw-fg-muted)" }}>
											Disk sizing and per-task limits. Defaults are used unless
											a real placement has been selected.
										</p>
									)}
								</Panel>
							) : null}
						</>
					) : null}
					<div className="flex flex-wrap gap-3">
						<AppLink
							className="mfw-focus underline"
							to={`${href.settings()}?tab=runpod`}
						>
							Open global RunPod setup
						</AppLink>
						<AppLink className="mfw-focus underline" to={href.runpod()}>
							Open RunPod operations
						</AppLink>
					</div>
				</div>
			</Panel>

			<Panel title="Notifications">
				<div className="flex flex-col gap-3">
					<Toggle
						label="Notify on run outcomes"
						restart={restart("notify")}
						checked={draft.notifyEnabled}
						onChange={(v) => set("notifyEnabled", v)}
					/>
					{draft.notifyEnabled ? (
						<div className="grid gap-3 sm:grid-cols-2">
							<Setting label="webhook" hint="POSTed to on each notification.">
								<Input
									type="url"
									aria-label="Notification webhook"
									placeholder="https://hooks.example.com/mfw"
									value={draft.notifyWebhook}
									onChange={(e) => set("notifyWebhook", e.target.value)}
								/>
							</Setting>
							<Setting
								label="command"
								hint="Runs locally for each notification. Blank uses only the webhook."
							>
								<Input
									aria-label="Notification command"
									placeholder="notify-send mfw"
									value={draft.notifyCommand}
									onChange={(e) => set("notifyCommand", e.target.value)}
								/>
							</Setting>
							<Setting
								label="timeout (ms)"
								hint="Blank uses the default timeout."
							>
								<Input
									type="number"
									min={1}
									className="max-w-40"
									aria-label="Notification timeout in milliseconds"
									value={draft.notifyTimeoutMs}
									onChange={(e) => set("notifyTimeoutMs", e.target.value)}
								/>
							</Setting>
						</div>
					) : (
						<p
							style={{
								color: "var(--mfw-fg-faint)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							Run outcomes are recorded in the inbox either way; this only adds
							an outbound webhook or command.
						</p>
					)}
				</div>
			</Panel>

			{dirty ? (
				<div
					className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border px-3 py-2"
					style={{
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-md)",
						background: "var(--mfw-bg-subtle)",
					}}
				>
					<span
						className="mfw-pulse"
						style={{ color: "var(--mfw-warn)" }}
						aria-live="polite"
					>
						Unsaved changes
					</span>
					{problem ? (
						<span style={{ color: "var(--mfw-warn)" }}>· {problem}</span>
					) : pending.length > 0 ? (
						<span
							style={{
								color: "var(--mfw-fg-muted)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							· Restart required for {pending.join(", ")}
						</span>
					) : null}
					<span className="flex-1" />
					{saveError ? (
						<span role="alert" style={{ color: "var(--mfw-critical)" }}>
							{saveError}
						</span>
					) : null}
					<Button
						size="sm"
						variant="ghost"
						disabled={save.isPending}
						onClick={() => {
							setSaveError(null);
							setDraft(base);
						}}
					>
						Discard
					</Button>
					<Button
						size="sm"
						disabled={
							save.isPending ||
							problem !== null ||
							Object.keys(patch).length === 0
						}
						onClick={() => save.mutate({ project, patch })}
					>
						{save.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			) : null}
		</>
	);
}
