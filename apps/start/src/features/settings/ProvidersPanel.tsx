import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleSlash, ExternalLink, KeyRound, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";

/**
 * Agent CLIs on this machine and their credentials, driven by `providers.catalogue`.
 *
 *  1. `drivable` means an adapter can run the provider end to end; others are
 *     detected, greyed with the reason, and not selectable.
 *  2. A subscription provider is never asked for an API key.
 *
 * Keys are write-only: `ProviderSettings` only answers `hasKey`.
 */

type Catalogue = RouterOutputs["settings"]["providers"]["catalogue"];
type Provider = Catalogue["providers"][number];
type Auth = Provider["auth"][number];

export function ProvidersPanel() {
	const trpc = useTRPC();
	const [adding, setAdding] = useState(false);
	const catalogue = useQuery(trpc.settings.providers.catalogue.queryOptions());
	// What is in `credentials.json`; distinct from "satisfied", which a login file or env var can do.
	const stored = useQuery(trpc.settings.providers.list.queryOptions());

	if (catalogue.isLoading) {
		return (
			<Panel title="Agent CLIs">
				<LoadingRows rows={5} />
			</Panel>
		);
	}
	if (catalogue.error || !catalogue.data) {
		return (
			<Panel title="Agent CLIs">
				<ErrorState
					title="Could not load providers"
					error={catalogue.error}
					onRetry={() => void catalogue.refetch()}
				/>
			</Panel>
		);
	}

	const data = catalogue.data;
	const storedIds = new Set((stored.data ?? []).map((p) => p.id));
	const selectable = new Set(data.selectableProviderIds);

	// Show only providers that are set up (usable and authenticated, or holding a key); the rest live behind Add.
	const configured = data.providers.filter(
		(p) =>
			selectable.has(p.id) &&
			(p.auth.some((a) => a.configured) ||
				p.auth.some((a) => a.credentialId && storedIds.has(a.credentialId))),
	);
	const addable = data.providers.filter((p) => !configured.includes(p));

	return (
		<div className="flex flex-col gap-3">
			<Panel
				title="Agent CLIs"
				actions={
					<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
						<Plus aria-hidden /> Add
					</Button>
				}
			>
				<div className="flex flex-col gap-3">
					{configured.length === 0 ? (
						<Empty
							title="No provider configured."
							description="Add a coding-agent provider to run tasks."
							action={
								<Button
									size="sm"
									variant="outline"
									onClick={() => setAdding(true)}
								>
									<Plus aria-hidden /> Add a provider
								</Button>
							}
						/>
					) : (
						configured.map((provider) => (
							<ProviderRow
								key={provider.id}
								provider={provider}
								storedIds={storedIds}
							/>
						))
					)}
				</div>
			</Panel>

			<AddProviderDialog
				open={adding}
				onOpenChange={setAdding}
				providers={addable}
				storedIds={storedIds}
				checkedOn={data.modelSnapshotCheckedOn}
			/>

			<ExtraCredentials
				rows={data.extraCredentials.filter(
					(row) =>
						row.id !== "runpod" &&
						row.id !== "openrouter" &&
						row.id !== "openrouter-management",
				)}
			/>
		</div>
	);
}

/** The full catalogue on demand, including detected providers mfw cannot drive. */
function AddProviderDialog({
	open,
	onOpenChange,
	providers,
	storedIds,
	checkedOn,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	providers: Provider[];
	storedIds: Set<string>;
	checkedOn: string;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add an agent CLI</DialogTitle>
					<DialogDescription>
						Availability and models checked on {checkedOn}.
					</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-100 flex-col gap-3 overflow-y-auto">
					{providers.map((provider) => (
						<ProviderRow
							key={provider.id}
							provider={provider}
							storedIds={storedIds}
						/>
					))}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Auth methods to show for a provider. An api-key method is hidden when a
 * subscription method on the same provider is satisfied, unless a key is
 * stored (else it would be invisible and unremovable; `extraCredentials` only
 * covers keys no catalogue entry claims).
 */
export function visibleAuth(provider: Provider, storedIds: Set<string>) {
	const subscribed = provider.auth.some(
		(a) => a.kind === "subscription" && a.configured,
	);
	if (!subscribed) return provider.auth;
	return provider.auth.filter(
		(a) =>
			a.kind !== "api-key" ||
			(a.credentialId !== undefined && storedIds.has(a.credentialId)),
	);
}

/** One provider: what it is, whether it is here, and how it authenticates. */
function ProviderRow({
	provider,
	storedIds,
}: {
	provider: Provider;
	storedIds: Set<string>;
}) {
	return (
		// Non-drivable entries are dimmed, not hidden, so "installed but not drivable" stays visible.
		<div
			className="flex flex-col gap-1.5"
			style={{ opacity: provider.drivable ? 1 : 0.65 }}
		>
			<div className="flex flex-wrap items-center gap-2">
				{provider.drivable ? null : (
					<CircleSlash
						aria-hidden
						className="size-3.5 shrink-0"
						style={{ color: "var(--mfw-fg-faint)" }}
					/>
				)}
				<span className="font-medium">{provider.name}</span>
				<Mono value={provider.id} />
				{provider.drivable ? (
					<Chip tone="ok">usable</Chip>
				) : (
					<Chip>not drivable</Chip>
				)}
				{provider.installed ? (
					<Chip tone="ok">
						{provider.version ? `v${provider.version}` : "installed"}
					</Chip>
				) : (
					<Chip tone="warn">not found</Chip>
				)}
				{provider.docsUrl ? (
					<a
						href={provider.docsUrl}
						target="_blank"
						rel="noreferrer"
						className="mfw-focus inline-flex items-center gap-1"
						style={{ fontSize: "var(--mfw-text-xs)" }}
					>
						docs
						<ExternalLink aria-hidden className="size-3" />
					</a>
				) : null}
			</div>

			<p
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				{provider.description}
			</p>

			{provider.unsupportedReason ? (
				<p
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{provider.unsupportedReason}
				</p>
			) : null}

			<div
				className="flex flex-wrap gap-x-4 gap-y-1"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				<span>
					looks for <Mono value={provider.bin} />
				</span>
				{provider.path ? (
					<span>
						at <Mono value={provider.path} />
					</span>
				) : null}
				{provider.versionError ? (
					<span style={{ color: "var(--mfw-warn)" }}>
						version check failed: {provider.versionError}
					</span>
				) : null}
			</div>

			<ul className="flex flex-col gap-1.5 pl-0">
				{visibleAuth(provider, storedIds).map((auth) => (
					<AuthRow
						key={`${auth.kind}:${auth.credentialId ?? ""}`}
						auth={auth}
						hasStoredKey={
							auth.credentialId !== undefined &&
							storedIds.has(auth.credentialId)
						}
					/>
				))}
			</ul>
		</div>
	);
}

/** One auth method. Subscription rows are read-only (a login, not a key); only api-key methods get a field. */
function AuthRow({
	auth,
	hasStoredKey,
}: {
	auth: Auth;
	hasStoredKey: boolean;
}) {
	return (
		<li
			className="flex flex-col gap-1 border-l-2 pl-2"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="flex flex-wrap items-center gap-2">
				{auth.kind === "api-key" ? (
					<KeyRound
						aria-hidden
						className="size-3.5 shrink-0"
						style={{ color: "var(--mfw-fg-faint)" }}
					/>
				) : null}
				<span style={{ fontSize: "var(--mfw-text-xs)" }}>
					{auth.kind === "subscription" ? "Subscription" : "API key"}
				</span>
				<Chip tone={auth.configured ? "ok" : "warn"}>
					{auth.configured ? "configured" : "not configured"}
				</Chip>
				{auth.via ? (
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						via <Mono value={auth.via} />
					</span>
				) : null}
			</div>

			{/* Verbatim: the daemon owns the instructions, and paraphrasing them here
			    is how a UI ends up telling an operator to do something that stopped
			    being true two releases ago. */}
			<p
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				{auth.hint}
			</p>

			{auth.credentialId !== undefined ? (
				<KeyField
					credentialId={auth.credentialId}
					hasStoredKey={hasStoredKey}
				/>
			) : null}
		</li>
	);
}

/** Store or remove ONE known credential id. The id is never typed. */
function KeyField({
	credentialId,
	hasStoredKey,
}: {
	credentialId: string;
	hasStoredKey: boolean;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [apiKey, setApiKey] = useState("");
	const [removing, setRemoving] = useState(false);

	const invalidate = () => {
		void queryClient.invalidateQueries(
			trpc.settings.providers.list.queryFilter(),
		);
		void queryClient.invalidateQueries(
			trpc.settings.providers.catalogue.queryFilter(),
		);
	};

	const setKey = useMutation(
		trpc.settings.providers.set.mutationOptions({
			meta: { label: "Save API key" },
			onSuccess: (provider) => {
				setApiKey("");
				toast({ tone: "success", title: `Key stored for ${provider.id}` });
			},
			onSettled: invalidate,
		}),
	);

	const removeKey = useMutation(
		trpc.settings.providers.remove.mutationOptions({
			meta: { label: "Remove API key" },
			onSuccess: (provider) => {
				setRemoving(false);
				toast({ tone: "success", title: `Key removed for ${provider.id}` });
			},
			onSettled: invalidate,
		}),
	);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Input
				type="password"
				className="max-w-64"
				aria-label={`API key for ${credentialId}`}
				placeholder={hasStoredKey ? "Replace the stored key" : "Paste a key"}
				autoComplete="off"
				spellCheck={false}
				value={apiKey}
				onChange={(e) => setApiKey(e.target.value)}
			/>
			<Button
				size="xs"
				disabled={apiKey === "" || setKey.isPending}
				onClick={() => setKey.mutate({ id: credentialId, apiKey })}
			>
				{setKey.isPending
					? "Storing…"
					: hasStoredKey
						? "Replace key"
						: "Store key"}
			</Button>
			{hasStoredKey ? (
				<Button
					size="xs"
					variant="destructive"
					onClick={() => setRemoving(true)}
				>
					Remove
				</Button>
			) : null}
			<span
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				Write-only: nothing in this app can read it back.
			</span>

			<RemoveKeyDialog
				id={credentialId}
				open={removing}
				pending={removeKey.isPending}
				onOpenChange={setRemoving}
				onConfirm={() => removeKey.mutate({ id: credentialId })}
			/>
		</div>
	);
}

/** Keys in `credentials.json` that no catalogue entry claims; listed so hand-stored keys stay visible and removable. */
function ExtraCredentials({ rows }: { rows: Catalogue["extraCredentials"] }) {
	const [removing, setRemoving] = useState<string | null>(null);
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const removeKey = useMutation(
		trpc.settings.providers.remove.mutationOptions({
			meta: { label: "Remove API key" },
			onSuccess: (provider) => {
				setRemoving(null);
				toast({ tone: "success", title: `Key removed for ${provider.id}` });
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.settings.providers.list.queryFilter(),
				);
				void queryClient.invalidateQueries(
					trpc.settings.providers.catalogue.queryFilter(),
				);
			},
		}),
	);

	if (rows.length === 0) return null;

	return (
		<Panel title="Other stored credentials">
			<div className="flex flex-col gap-2">
				<p
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					Stored credentials not assigned to a provider.
				</p>
				<ul className="flex flex-col gap-1.5">
					{rows.map((row) => (
						<li key={row.id} className="flex flex-wrap items-center gap-2">
							<KeyRound
								aria-hidden
								className="size-3.5 shrink-0"
								style={{ color: "var(--mfw-fg-faint)" }}
							/>
							<Mono value={row.id} />
							<Chip tone="ok">key stored</Chip>
							<span className="flex-1" />
							<Button
								size="xs"
								variant="destructive"
								onClick={() => setRemoving(row.id)}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			</div>

			<RemoveKeyDialog
				id={removing}
				open={removing !== null}
				pending={removeKey.isPending}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
				onConfirm={() => {
					if (removing) removeKey.mutate({ id: removing });
				}}
			/>
		</Panel>
	);
}

function RemoveKeyDialog({
	id,
	open,
	pending,
	onOpenChange,
	onConfirm,
}: {
	id: string | null;
	open: boolean;
	pending: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Remove this stored key"
			confirmText={id ?? undefined}
			confirmLabel="Remove key"
			pending={pending}
			description={
				<>
					Deletes the stored key for <span className="mfw-num">{id}</span> from
					this machine. It cannot be recovered from here, so you will need the
					original key to put it back. Runs that depend on it will start failing
					to authenticate.
				</>
			}
			onConfirm={onConfirm}
		/>
	);
}
