import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "~/components/ConfirmDialog";
import { Empty } from "~/components/Empty";
import { ErrorState } from "~/components/ErrorState";
import { LoadingRows } from "~/components/Loading";
import { Chip, Panel } from "~/components/Page";
import { RelativeTime } from "~/components/RelativeTime";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/lib/toast";
import type { RouterInputs, RouterOutputs } from "~/lib/trpc";
import { useTRPC } from "~/lib/trpc";
import { Setting } from "../settings/controls";

type Host = RouterOutputs["hosts"]["list"][number];
type AddInput = RouterInputs["hosts"]["add"];

const HEALTH_TONE = {
	ok: "ok",
	refused: "critical",
	error: "warn",
	unreachable: "warn",
} as const;

function bytes(value: number | null): string | null {
	if (value === null) return null;
	return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Registry SSH hosts: boxes that run agents over SSH. A host is schedulable
 * only after a probe passes (not root, no passwordless sudo, bwrap where
 * required); its capacity is the `remote.<id>.slots` resource above.
 */
export function HostsPanel() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const hosts = useQuery({
		...trpc.hosts.list.queryOptions(),
		refetchInterval: 15_000,
	});
	const [adding, setAdding] = useState(false);
	const [publicKey, setPublicKey] = useState<{
		id: string;
		key: string;
	} | null>(null);
	const [removing, setRemoving] = useState<Host | null>(null);
	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries(trpc.hosts.list.queryFilter()),
			queryClient.invalidateQueries(trpc.hostResources.read.queryFilter()),
		]);
	const probe = useMutation(
		trpc.hosts.probe.mutationOptions({
			meta: { label: "Probe SSH host" },
			onSuccess: (observation) =>
				toast({
					tone: observation.health === "ok" ? "success" : "warning",
					title: `Probe: ${observation.health}`,
					description: observation.problems.join("; ") || undefined,
				}),
			onSettled: invalidate,
		}),
	);
	const remove = useMutation(
		trpc.hosts.remove.mutationOptions({
			meta: { label: "Remove SSH host" },
			onSuccess: () => setRemoving(null),
			onSettled: invalidate,
		}),
	);

	return (
		<Panel
			title="SSH hosts"
			actions={
				<Button size="xs" variant="outline" onClick={() => setAdding(!adding)}>
					<Plus aria-hidden /> Add host
				</Button>
			}
		>
			<div className="flex flex-col gap-3">
				<p style={{ color: "var(--mfw-fg-muted)" }}>
					Boxes that run agents over SSH. Agents run with every permission of
					the box user, so use a dedicated user without sudo. Shared hosts
					always sandbox with bwrap. Tasks reach a host with{" "}
					<code>execution_target: ssh</code> (or <code>ssh:&lt;id&gt;</code>),
					or through the project's placement setting.
				</p>
				{adding ? (
					<AddHostForm
						onDone={async (id, key) => {
							setAdding(false);
							setPublicKey({ id, key });
							await invalidate();
						}}
					/>
				) : null}
				{publicKey ? (
					<div
						className="flex flex-col gap-1 border p-2"
						style={{ borderColor: "var(--mfw-border)" }}
					>
						<span>
							<KeyRound aria-hidden className="inline size-3.5" /> Append this
							key to <code>~/.ssh/authorized_keys</code> of the host user on{" "}
							<strong>{publicKey.id}</strong>, then probe the host:
						</span>
						<code className="break-all select-all">{publicKey.key}</code>
						<div>
							<Button
								size="xs"
								variant="ghost"
								onClick={() => setPublicKey(null)}
							>
								Done
							</Button>
						</div>
					</div>
				) : null}
				{hosts.isLoading ? (
					<LoadingRows rows={2} />
				) : hosts.error ? (
					<ErrorState
						title="Could not read SSH hosts"
						error={hosts.error}
						onRetry={() => void hosts.refetch()}
					/>
				) : (hosts.data ?? []).length === 0 ? (
					<Empty
						title="No SSH hosts"
						description="Add a box to run agents on it over SSH."
					/>
				) : (
					<ul className="flex flex-col gap-2">
						{(hosts.data ?? []).map((host) => (
							<HostRow
								key={host.config.id}
								host={host}
								probing={
									probe.isPending && probe.variables?.id === host.config.id
								}
								onProbe={() => probe.mutate({ id: host.config.id })}
								onKey={async () => {
									const key = await queryClient.fetchQuery(
										trpc.hosts.publicKey.queryOptions({ id: host.config.id }),
									);
									setPublicKey({ id: host.config.id, key });
								}}
								onRemove={() => setRemoving(host)}
							/>
						))}
					</ul>
				)}
			</div>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
				title="Remove SSH host"
				confirmLabel="Remove host"
				pending={remove.isPending}
				description={
					removing
						? `Forget ${removing.config.id} and delete its SSH key on this machine. Refused while a run holds one of its slots.`
						: null
				}
				onConfirm={() => {
					if (removing) remove.mutate({ id: removing.config.id });
				}}
			/>
		</Panel>
	);
}

function HostRow({
	host,
	probing,
	onProbe,
	onKey,
	onRemove,
}: {
	host: Host;
	probing: boolean;
	onProbe: () => void;
	onKey: () => void;
	onRemove: () => void;
}) {
	const { config, observed } = host;
	const harnesses = Object.entries(observed?.harnesses ?? {}).filter(
		([, h]) => h.version,
	);
	return (
		<li
			className="flex flex-col gap-1.5 border p-2"
			style={{ borderColor: "var(--mfw-border)" }}
			aria-label={`SSH host ${config.id}`}
		>
			<div className="flex flex-wrap items-center gap-1.5">
				<strong>{config.id}</strong>
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					{config.user}@{config.address}:{config.port}
				</span>
				<Chip tone={config.trust === "shared" ? "info" : "neutral"}>
					{config.trust}
				</Chip>
				<Chip tone={config.sandbox === "bwrap" ? "ok" : "warn"}>
					{config.sandbox === "bwrap" ? "bwrap" : "no sandbox"}
				</Chip>
				{config.labels.map((label) => (
					<Chip key={label}>{label}</Chip>
				))}
				<Chip
					tone={host.slots.inUse >= host.slots.capacity ? "warn" : "neutral"}
				>
					{host.slots.inUse}/{host.slots.capacity || config.slots} slots
				</Chip>
				{observed ? (
					<Chip tone={HEALTH_TONE[observed.health]}>{observed.health}</Chip>
				) : (
					<Chip tone="warn">not probed</Chip>
				)}
				{host.schedulable ? <Chip tone="ok">schedulable</Chip> : null}
				<span className="ml-auto flex gap-1">
					<Button
						size="xs"
						variant="outline"
						disabled={probing}
						onClick={onProbe}
					>
						<RefreshCw aria-hidden /> Probe
					</Button>
					<Button size="xs" variant="ghost" onClick={onKey}>
						<KeyRound aria-hidden /> Key
					</Button>
					<Button size="xs" variant="ghost" onClick={onRemove}>
						<Trash2 aria-hidden /> Remove
					</Button>
				</span>
			</div>
			{!host.schedulable && host.reason ? (
				<p role="status" style={{ color: "var(--mfw-warn)" }}>
					Not schedulable: {host.reason}
				</p>
			) : null}
			{observed ? (
				<div
					className="flex flex-wrap gap-x-3 gap-y-1"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					<span>
						probed <RelativeTime value={observed.checkedAt} />
					</span>
					{harnesses.length ? (
						harnesses.map(([id, h]) => (
							<span key={id}>
								{id} {h.version} {h.auth ? "(logged in)" : "(not logged in)"}
							</span>
						))
					) : (
						<span>no harness installed</span>
					)}
					{observed.gpus > 0 ? <span>{observed.gpus} GPU</span> : null}
					{bytes(observed.memAvailableBytes) ? (
						<span>{bytes(observed.memAvailableBytes)} RAM free</span>
					) : null}
					{bytes(observed.diskFreeBytes) ? (
						<span>{bytes(observed.diskFreeBytes)} disk free</span>
					) : null}
				</div>
			) : null}
		</li>
	);
}

function AddHostForm({
	onDone,
}: {
	onDone: (id: string, publicKey: string) => void | Promise<void>;
}) {
	const trpc = useTRPC();
	const [draft, setDraft] = useState({
		id: "",
		address: "",
		port: "22",
		user: "",
		trust: "owned" as AddInput["trust"],
		sandbox: "bwrap" as NonNullable<AddInput["sandbox"]>,
		labels: "",
		slots: "1",
		hostKey: "",
	});
	const set = <K extends keyof typeof draft>(
		key: K,
		value: (typeof draft)[K],
	) => setDraft((d) => ({ ...d, [key]: value }));
	const scan = useMutation(
		trpc.hosts.scanKeys.mutationOptions({ meta: { label: "Scan host keys" } }),
	);
	const add = useMutation(
		trpc.hosts.add.mutationOptions({
			meta: { label: "Add SSH host" },
			onSuccess: (result) => onDone(result.host.config.id, result.publicKey),
		}),
	);
	const port = Number(draft.port) || 22;
	return (
		<form
			className="grid grid-cols-1 gap-2 border p-2 sm:grid-cols-2"
			style={{ borderColor: "var(--mfw-border)" }}
			onSubmit={(event) => {
				event.preventDefault();
				add.mutate({
					id: draft.id.trim(),
					address: draft.address.trim(),
					port,
					user: draft.user.trim(),
					trust: draft.trust,
					sandbox: draft.trust === "shared" ? "bwrap" : draft.sandbox,
					labels: draft.labels
						.split(",")
						.map((l) => l.trim())
						.filter(Boolean),
					slots: Number(draft.slots) || 1,
					hostKey: draft.hostKey.trim(),
				});
			}}
		>
			<Setting label="Id">
				<Input
					aria-label="Host id"
					placeholder="gpu-box"
					value={draft.id}
					onChange={(e) => set("id", e.target.value)}
				/>
			</Setting>
			<Setting label="Address and port">
				<span className="flex gap-1">
					<Input
						aria-label="Host address"
						placeholder="box.example.net"
						value={draft.address}
						onChange={(e) => set("address", e.target.value)}
					/>
					<Input
						aria-label="SSH port"
						className="w-20"
						inputMode="numeric"
						value={draft.port}
						onChange={(e) => set("port", e.target.value)}
					/>
				</span>
			</Setting>
			<Setting label="User" hint="A dedicated unprivileged user, never root.">
				<Input
					aria-label="Host user"
					placeholder="agent"
					value={draft.user}
					onChange={(e) => set("user", e.target.value)}
				/>
			</Setting>
			<Setting
				label="Trust"
				hint="Shared: bwrap is mandatory and only listed secrets are sent."
			>
				<Select
					value={draft.trust}
					onValueChange={(value) => set("trust", value as AddInput["trust"])}
				>
					<SelectTrigger aria-label="Host trust">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="owned">owned (my own box)</SelectItem>
						<SelectItem value="shared">shared</SelectItem>
					</SelectContent>
				</Select>
			</Setting>
			<Setting label="Sandbox">
				<Select
					value={draft.trust === "shared" ? "bwrap" : draft.sandbox}
					disabled={draft.trust === "shared"}
					onValueChange={(value) =>
						set("sandbox", value as NonNullable<AddInput["sandbox"]>)
					}
				>
					<SelectTrigger aria-label="Host sandbox">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="bwrap">bwrap</SelectItem>
						<SelectItem value="none">none (owned only)</SelectItem>
					</SelectContent>
				</Select>
			</Setting>
			<Setting label="Labels and slots">
				<span className="flex gap-1">
					<Input
						aria-label="Host labels"
						placeholder="gpu, cuda"
						value={draft.labels}
						onChange={(e) => set("labels", e.target.value)}
					/>
					<Input
						aria-label="Host slots"
						className="w-20"
						inputMode="numeric"
						value={draft.slots}
						onChange={(e) => set("slots", e.target.value)}
					/>
				</span>
			</Setting>
			<div className="sm:col-span-2">
				<Setting
					label="Pinned host key"
					hint="Scan, then compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the box before choosing it."
				>
					<span className="flex flex-col gap-1">
						<span className="flex gap-1">
							<Input
								aria-label="Pinned host key"
								placeholder="ssh-ed25519 AAAA…"
								value={draft.hostKey}
								onChange={(e) => set("hostKey", e.target.value)}
							/>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={!draft.address.trim() || scan.isPending}
								onClick={() =>
									scan.mutate({ address: draft.address.trim(), port })
								}
							>
								Scan
							</Button>
						</span>
						{scan.data?.map((offered) => (
							<label key={offered.key} className="flex items-center gap-1.5">
								<input
									type="radio"
									name="host-key"
									checked={draft.hostKey === offered.key}
									onChange={() => set("hostKey", offered.key)}
								/>
								<code>{offered.key.split(" ")[0]}</code>
								<code>{offered.fingerprint}</code>
							</label>
						))}
					</span>
				</Setting>
			</div>
			<div className="flex gap-1 sm:col-span-2">
				<Button
					type="submit"
					size="sm"
					disabled={add.isPending || !draft.hostKey.trim()}
				>
					Add host
				</Button>
			</div>
		</form>
	);
}
