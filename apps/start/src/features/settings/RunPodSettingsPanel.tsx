import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "~/components/ConfirmDialog";
import { Chip, Panel } from "~/components/Page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useToast } from "~/lib/toast";
import { useTRPC } from "~/lib/trpc";
import { Setting } from "./controls";
import {
	bindRunPodSafetyDraft,
	editRunPodSafetyDraft,
	markRunPodSafetyConflict,
	runPodSafetyDraftDirty,
	runPodSafetyReview,
	type SafetyDraft,
	validateRunPodSafetyDraft,
} from "./runpodSafetyDraft";

export function RunPodSettingsPanel() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const account = useQuery(trpc.runpod.get.queryOptions());
	const [apiKey, setApiKey] = useState("");
	const [removeOpen, setRemoveOpen] = useState(false);
	const [safetyReview, setSafetyReview] = useState<{
		safety: ReturnType<typeof validateRunPodSafetyDraft>;
		description: string;
	} | null>(null);
	const [binding, setBinding] = useState<ReturnType<
		typeof bindRunPodSafetyDraft
	> | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!account.data || binding !== null) return;
		setBinding(
			bindRunPodSafetyDraft(
				account.data.settings.policy,
				account.data.settings.version,
			),
		);
	}, [account.data, binding]);

	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries(trpc.runpod.get.queryFilter()),
			queryClient.invalidateQueries(trpc.settings.providers.list.queryFilter()),
		]);
	};
	const setKey = useMutation(
		trpc.settings.providers.set.mutationOptions({
			meta: { label: "Store RunPod API key" },
			onSuccess: () => {
				setApiKey("");
				toast({ tone: "success", title: "RunPod API key stored" });
			},
			onSettled: invalidate,
		}),
	);
	const removeKey = useMutation(
		trpc.settings.providers.remove.mutationOptions({
			meta: { label: "Remove RunPod API key" },
			onSuccess: () => {
				setRemoveOpen(false);
				toast({ tone: "success", title: "RunPod API key removed" });
			},
			onSettled: invalidate,
		}),
	);
	const updateSafety = useMutation(
		trpc.runpod.updateSafety.mutationOptions({
			meta: { label: "Save RunPod cost safety" },
			onSuccess: (model) => {
				queryClient.setQueryData(trpc.runpod.get.queryKey(), model);
				setBinding(
					bindRunPodSafetyDraft(model.settings.policy, model.settings.version),
				);
				setSafetyReview(null);
				setError(null);
				toast({ tone: "success", title: "RunPod safety limits saved" });
			},
			onError: (cause) => {
				setSafetyReview(null);
				if ((cause as { data?: { code?: string } }).data?.code === "CONFLICT") {
					setBinding((current) =>
						current ? markRunPodSafetyConflict(current) : current,
					);
				}
				setError(cause instanceof Error ? cause.message : String(cause));
			},
			onSettled: invalidate,
		}),
	);

	const model = account.data;
	const draft = binding?.draft ?? null;
	const dirty = binding ? runPodSafetyDraftDirty(binding) : false;
	const prepareSafetyReview = () => {
		if (!model || !binding || binding.conflicted) return;
		try {
			const safety = validateRunPodSafetyDraft(binding.draft);
			const prior = validateRunPodSafetyDraft(binding.base);
			setError(null);
			setSafetyReview({
				safety,
				description: `${runPodSafetyReview(safety, prior, model.enabled)}. MFW will validate the stored key, reconcile live provider state, and keep dispatch closed if any safety check fails.`,
			});
		} catch (cause) {
			setSafetyReview(null);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const submit = () => {
		if (!model || !binding || binding.conflicted || !safetyReview) return;
		updateSafety.mutate({
			expectedVersion: binding.baseVersion,
			safety: safetyReview.safety,
			actor: "local-operator",
		});
	};
	const credentialValidated = Boolean(
		model?.credential.ready &&
			model.credential.validatedAt &&
			!model.credential.validationError,
	);

	return (
		<div className="flex flex-col gap-3">
			<Panel title="RunPod API key">
				<div className="flex flex-wrap items-center gap-2">
					<KeyRound aria-hidden className="size-4" />
					<Chip tone={credentialValidated ? "ok" : "warn"}>
						{credentialValidated
							? "Validated"
							: model?.credential.ready
								? "Needs validation"
								: "Not set"}
					</Chip>
					<span style={{ color: "var(--mfw-fg-muted)" }}>
						{credentialValidated
							? "The validated key is write-only and can be replaced or removed, but never displayed."
							: model?.credential.ready
								? `A key is present, but it is not validated${model.credential.validationError ? `: ${model.credential.validationError.replaceAll("_", " ")}` : ""}. Replace it or check the live account.`
								: "Paste a RunPod API key to validate the account and enable live inventory."}
					</span>
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<Input
						type="password"
						className="max-w-80"
						aria-label="RunPod API key"
						placeholder={
							model?.credential.ready
								? "Paste a replacement key"
								: "Paste API key"
						}
						autoComplete="off"
						spellCheck={false}
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
					/>
					<Button
						disabled={!apiKey.trim() || setKey.isPending}
						onClick={() =>
							setKey.mutate({ id: "runpod", apiKey: apiKey.trim() })
						}
					>
						{setKey.isPending
							? "Storing…"
							: model?.credential.ready
								? "Replace key"
								: "Store key"}
					</Button>
					{model?.credential.ready ? (
						<Button variant="destructive" onClick={() => setRemoveOpen(true)}>
							Remove key
						</Button>
					) : null}
				</div>
			</Panel>

			<Panel title="Cost safety">
				<div className="mb-3 flex items-center gap-2">
					<ShieldCheck aria-hidden className="size-4" />
					<Chip tone={model?.enabled ? "ok" : "neutral"}>
						{model?.enabled ? "Enabled" : "Not enabled"}
					</Chip>
					<span style={{ color: "var(--mfw-fg-muted)" }}>
						Hard limits are checked before provider creation and against fresh
						full-account inventory.
					</span>
				</div>
				{draft ? (
					<>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							{(
								[
									["Maximum per Pod ($/hr)", "maxHourlyPrice"],
									["Maximum total ($/hr)", "maxAggregateHourlyPrice"],
									["Maximum runtime (minutes)", "maxRuntimeMinutes"],
									["Maximum spend per run ($)", "maxRunSpend"],
								] as Array<[string, keyof SafetyDraft]>
							).map(([label, key]) => (
								<Setting key={key} label={label}>
									<Input
										aria-label={label}
										inputMode="decimal"
										disabled={binding?.conflicted}
										value={draft[key]}
										onChange={(event) =>
											setBinding((current) =>
												current
													? editRunPodSafetyDraft(
															current,
															key,
															event.target.value,
														)
													: current,
											)
										}
									/>
								</Setting>
							))}
						</div>
						<p className="mt-3" style={{ color: "var(--mfw-fg-muted)" }}>
							Provider choices are unrestricted globally. Projects can
							optionally narrow choices and costs. Changes to these machine-wide
							limits require confirmation.
						</p>
						{error ? (
							<p role="alert" style={{ color: "var(--mfw-critical)" }}>
								{error}
							</p>
						) : null}
						{binding?.conflicted ? (
							<div
								role="alert"
								className="mt-3 flex items-center justify-between gap-3"
							>
								<span>
									These limits changed elsewhere. Reload the latest values and
									review them before editing or saving again.
								</span>
								<Button
									variant="outline"
									disabled={
										account.isFetching ||
										model?.settings.version === binding.baseVersion
									}
									onClick={() => {
										if (!model) return;
										setBinding(
											bindRunPodSafetyDraft(
												model.settings.policy,
												model.settings.version,
											),
										);
										setError(null);
									}}
								>
									Reload latest limits
								</Button>
								{model?.settings.version === binding.baseVersion ? (
									<span style={{ color: "var(--mfw-fg-muted)" }}>
										Waiting for the latest server version…
									</span>
								) : null}
							</div>
						) : null}
						<div className="mt-3 flex flex-col items-end gap-1">
							<Button
								disabled={
									(!dirty && model?.enabled) ||
									updateSafety.isPending ||
									!credentialValidated ||
									binding?.conflicted
								}
								onClick={prepareSafetyReview}
							>
								{model?.enabled
									? "Review limit changes"
									: "Review and enable RunPod"}
							</Button>
							{!credentialValidated ? (
								<span style={{ color: "var(--mfw-fg-muted)" }}>
									Store and validate a RunPod API key before changing limits.
								</span>
							) : null}
						</div>
					</>
				) : null}
			</Panel>

			<ConfirmDialog
				open={safetyReview !== null}
				onOpenChange={(open) => {
					if (!open) setSafetyReview(null);
				}}
				title={
					model?.enabled
						? "Change RunPod safety limits"
						: "Enable RunPod with these limits"
				}
				description={safetyReview?.description ?? "Review the proposed limits."}
				confirmLabel={model?.enabled ? "Save limits" : "Enable RunPod"}
				pending={updateSafety.isPending}
				onConfirm={submit}
			/>
			<ConfirmDialog
				open={removeOpen}
				onOpenChange={setRemoveOpen}
				title="Remove RunPod API key"
				description="Remote dispatch will fail closed until a key is stored again. Existing provider resources are not deleted."
				confirmLabel="Remove key"
				pending={removeKey.isPending}
				onConfirm={() => removeKey.mutate({ id: "runpod" })}
			/>
		</div>
	);
}
