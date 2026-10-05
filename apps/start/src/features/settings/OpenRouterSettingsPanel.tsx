import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { AppLink } from "~/components/AppLink";
import { ConfirmDialog } from "~/components/ConfirmDialog";
import { Chip, Panel } from "~/components/Page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useToast } from "~/lib/toast";
import { useTRPC } from "~/lib/trpc";
import { href } from "~/routes";

export function OpenRouterSettingsPanel() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const account = useQuery(trpc.openrouter.get.queryOptions());
	const [apiKey, setApiKey] = useState("");
	const [managementKey, setManagementKey] = useState("");
	const [removeOpen, setRemoveOpen] = useState(false);
	const [removeManagementOpen, setRemoveManagementOpen] = useState(false);
	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries(trpc.openrouter.get.queryFilter()),
			queryClient.invalidateQueries(trpc.settings.providers.list.queryFilter()),
			queryClient.invalidateQueries(
				trpc.settings.providers.catalogue.queryFilter(),
			),
		]);
	};
	const setKey = useMutation(
		trpc.settings.providers.set.mutationOptions({
			meta: { label: "Store OpenRouter API key" },
			onSuccess: () => {
				setApiKey("");
				toast({ tone: "success", title: "OpenRouter API key validated" });
			},
			onSettled: invalidate,
		}),
	);
	const removeKey = useMutation(
		trpc.settings.providers.remove.mutationOptions({
			meta: { label: "Remove OpenRouter API key" },
			onSuccess: () => {
				setRemoveOpen(false);
				toast({ tone: "success", title: "OpenRouter API key removed" });
			},
			onSettled: invalidate,
		}),
	);
	const setManagementKeyMutation = useMutation(
		trpc.settings.providers.set.mutationOptions({
			meta: { label: "Store OpenRouter management key" },
			onSuccess: () => {
				setManagementKey("");
				toast({
					tone: "success",
					title: "OpenRouter management key validated",
				});
			},
			onSettled: invalidate,
		}),
	);
	const removeManagementKey = useMutation(
		trpc.settings.providers.remove.mutationOptions({
			meta: { label: "Remove OpenRouter management key" },
			onSuccess: () => {
				setRemoveManagementOpen(false);
				toast({
					tone: "success",
					title: "OpenRouter management key removed",
				});
			},
			onSettled: invalidate,
		}),
	);
	const model = account.data;
	const validated = Boolean(
		model?.credential.ready &&
			model.credential.validatedAt &&
			!model.credential.validationError,
	);
	const managementValidated = Boolean(
		model?.managementCredential.ready &&
			model.managementCredential.validatedAt &&
			!model.managementCredential.validationError,
	);

	return (
		<div className="flex flex-col gap-3">
			<Panel title="Inference API key">
				<div className="flex flex-wrap items-center gap-2">
					<KeyRound aria-hidden className="size-4" />
					<Chip
						tone={
							validated ? "ok" : model?.credential.ready ? "warn" : "neutral"
						}
					>
						{validated
							? "Validated"
							: model?.credential.ready
								? "Check failed"
								: "Not set"}
					</Chip>
					<span style={{ color: "var(--mfw-fg-muted)" }}>
						Used for model requests and this key's own usage totals. It cannot
						be a management key. It is write-only: MFW never displays it after
						storing it.
					</span>
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<Input
						type="password"
						className="max-w-80"
						aria-label="OpenRouter API key"
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
							setKey.mutate({ id: "openrouter", apiKey: apiKey.trim() })
						}
					>
						{setKey.isPending
							? "Validating…"
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
				{model?.credential.validationError ? (
					<p
						className="mt-2"
						role="alert"
						style={{ color: "var(--mfw-critical)" }}
					>
						The last account check failed. Replace the key or retry from the
						OpenRouter usage page.
					</p>
				) : null}
			</Panel>
			<Panel title="Management key">
				<div className="flex flex-wrap items-center gap-2">
					<KeyRound aria-hidden className="size-4" />
					<Chip
						tone={
							managementValidated
								? "ok"
								: model?.managementCredential.ready
									? "warn"
									: "neutral"
						}
					>
						{managementValidated
							? "Validated"
							: model?.managementCredential.ready
								? "Check failed"
								: "Not set"}
					</Chip>
					<span style={{ color: "var(--mfw-fg-muted)" }}>
						Used only for account-wide spending, model, provider, request, and
						token analytics. It is write-only and never used for inference.
					</span>
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<Input
						type="password"
						className="max-w-80"
						aria-label="OpenRouter management key"
						placeholder={
							model?.managementCredential.ready
								? "Paste a replacement management key"
								: "Paste management key"
						}
						autoComplete="off"
						spellCheck={false}
						value={managementKey}
						onChange={(event) => setManagementKey(event.target.value)}
					/>
					<Button
						disabled={
							!managementKey.trim() || setManagementKeyMutation.isPending
						}
						onClick={() =>
							setManagementKeyMutation.mutate({
								id: "openrouter-management",
								apiKey: managementKey.trim(),
							})
						}
					>
						{setManagementKeyMutation.isPending
							? "Validating…"
							: model?.managementCredential.ready
								? "Replace key"
								: "Store key"}
					</Button>
					{model?.managementCredential.ready ? (
						<Button
							variant="destructive"
							onClick={() => setRemoveManagementOpen(true)}
						>
							Remove key
						</Button>
					) : null}
				</div>
				{model?.managementCredential.validationError ? (
					<p
						className="mt-2"
						role="alert"
						style={{ color: "var(--mfw-critical)" }}
					>
						The last analytics check failed. Replace the management key or retry
						from the OpenRouter usage page.
					</p>
				) : null}
			</Panel>
			<Panel title="What the dashboard can show">
				<p>
					The inference key provides its own usage totals. The separate
					management key provides account-wide spending, model, provider,
					request, and token activity. MFW refreshes both automatically every 15
					seconds.
				</p>
				<div className="mt-2">
					<AppLink to={href.openrouter()}>Open OpenRouter usage</AppLink>
				</div>
			</Panel>
			<ConfirmDialog
				open={removeOpen}
				onOpenChange={setRemoveOpen}
				title="Remove OpenRouter API key"
				description="MFW will stop refreshing OpenRouter usage. This does not revoke the key in OpenRouter."
				confirmLabel="Remove key"
				pending={removeKey.isPending}
				onConfirm={() => removeKey.mutate({ id: "openrouter" })}
			/>
			<ConfirmDialog
				open={removeManagementOpen}
				onOpenChange={setRemoveManagementOpen}
				title="Remove OpenRouter management key"
				description="MFW will stop refreshing account-wide analytics. This does not revoke the key in OpenRouter and does not remove the inference key."
				confirmLabel="Remove key"
				pending={removeManagementKey.isPending}
				onConfirm={() =>
					removeManagementKey.mutate({ id: "openrouter-management" })
				}
			/>
		</div>
	);
}
