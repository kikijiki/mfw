import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Unlock } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useToast } from "../../lib/toast";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { Select, Setting } from "./controls";

/**
 * Project Semaphores: local serialization for exactly one project.
 *
 *  1. Force-release is destructive: the RUNNING run keeps executing without the
 *     exclusive use it thought it held. It needs a typed confirmation.
 *  2. `register` is an UPSERT that overwrites `policy` and `metadata` with `{}`
 *     when absent from the input. There is no editor for those blobs here, so
 *     editing an existing resource passes the loaded values back through.
 */

type Resource = RouterOutputs["resources"]["list"][number];

interface RegisterForm {
	id: string;
	name: string;
	type: "fixed" | "dynamic";
	cost: "free" | "paid";
	maxConcurrent: string;
	/** Carried through untouched when editing; absent when creating. */
	policy?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

const BLANK: RegisterForm = {
	id: "",
	name: "",
	type: "fixed",
	cost: "free",
	maxConcurrent: "1",
};

function editFormOf(resource: Resource): RegisterForm {
	return {
		id: resource.id,
		name: resource.name,
		type: resource.type,
		cost: resource.cost,
		maxConcurrent: String(resource.maxConcurrent),
		policy: resource.policy,
		metadata: resource.metadata,
	};
}

export function ProjectSemaphoresPanel({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const resources = useQuery(trpc.resources.list.queryOptions({ project }));
	const [form, setForm] = useState<RegisterForm | null>(null);
	const [release, setRelease] = useState<{
		resource: Resource;
		slot?: number;
	} | null>(null);
	const [unregister, setUnregister] = useState<Resource | null>(null);

	const invalidate = () =>
		void queryClient.invalidateQueries(
			trpc.resources.list.queryFilter({ project }),
		);

	const registerMutation = useMutation(
		trpc.resources.register.mutationOptions({
			meta: { label: "Register resource" },
			onSuccess: (resource) => {
				setForm(null);
				toast({ tone: "success", title: `${resource.id} saved` });
			},
			onSettled: invalidate,
		}),
	);

	const releaseMutation = useMutation(
		trpc.resources.forceRelease.mutationOptions({
			meta: { label: "Force release" },
			onSuccess: (result) => {
				setRelease(null);
				toast({
					tone: "success",
					title: `Released ${result.released} slot${result.released === 1 ? "" : "s"}`,
				});
			},
			onSettled: invalidate,
		}),
	);

	const unregisterMutation = useMutation(
		trpc.resources.unregister.mutationOptions({
			meta: { label: "Remove resource" },
			onSuccess: (result) => {
				setUnregister(null);
				toast({
					tone: "success",
					title: `Resource removed, freeing ${result.released} slot${result.released === 1 ? "" : "s"}`,
				});
			},
			onSettled: invalidate,
		}),
	);

	const rows = resources.data ?? [];
	const formInvalid =
		form === null ||
		form.id.trim() === "" ||
		!Number.isInteger(Number(form.maxConcurrent)) ||
		Number(form.maxConcurrent) < 1;

	return (
		<Panel
			title="Project Semaphores"
			actions={
				form === null ? (
					<Button size="xs" variant="outline" onClick={() => setForm(BLANK)}>
						<Plus aria-hidden /> Resource
					</Button>
				) : null
			}
		>
			<p
				className="mb-3"
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				These definitions serialize work only inside {project}. They cannot
				change machine capacity, host bindings, host leases, or external
				occupants. Manage host capacity on the{" "}
				<AppLink to={href.resources()}>Resources</AppLink> page.
			</p>
			{resources.isLoading ? (
				<LoadingRows rows={3} />
			) : resources.error ? (
				<ErrorState
					title="Could not list resources"
					error={resources.error}
					onRetry={() => void resources.refetch()}
				/>
			) : rows.length === 0 && form === null ? (
				<Empty
					title="No project semaphores configured"
					description="Add a project-local semaphore for work that must serialize only within this project."
					action={
						<Button size="sm" variant="outline" onClick={() => setForm(BLANK)}>
							<Plus aria-hidden /> Resource
						</Button>
					}
				/>
			) : (
				<ul className="flex flex-col gap-3">
					{rows.map((resource) => (
						<li
							key={resource.id}
							className="flex flex-col gap-1.5 border-b pb-3 last:border-b-0 last:pb-0"
							style={{ borderColor: "var(--mfw-border)" }}
						>
							<div className="flex flex-wrap items-center gap-2">
								<Mono value={resource.id} />
								{resource.name !== resource.id ? (
									<span style={{ color: "var(--mfw-fg-muted)" }}>
										{resource.name}
									</span>
								) : null}
								<Chip>{resource.type}</Chip>
								<Chip tone={resource.cost === "paid" ? "warn" : "neutral"}>
									{resource.cost}
								</Chip>
								<Chip tone={resource.free === 0 ? "warn" : "ok"}>
									{resource.free} of {resource.maxConcurrent} free
								</Chip>
								<span className="flex-1" />
								<Button
									size="xs"
									variant="ghost"
									onClick={() => setForm(editFormOf(resource))}
								>
									Edit
								</Button>
								{resource.holders.length > 0 ? (
									<Button
										size="xs"
										variant="destructive"
										onClick={() => setRelease({ resource })}
									>
										<Unlock aria-hidden /> Release all
									</Button>
								) : null}
								<Button
									size="xs"
									variant="destructive"
									onClick={() => setUnregister(resource)}
								>
									Remove
								</Button>
							</div>

							{resource.holders.length === 0 ? (
								<span
									style={{
										color: "var(--mfw-fg-faint)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									Nothing is holding this.
								</span>
							) : (
								<ul className="flex flex-col gap-1">
									{resource.holders.map((holder) => (
										<li
											key={holder.slot}
											className="flex flex-wrap items-center gap-2"
											style={{ fontSize: "var(--mfw-text-xs)" }}
										>
											<span
												className="mfw-num"
												style={{ color: "var(--mfw-fg-faint)" }}
											>
												slot {holder.slot}
											</span>
											<AppLink to={href.run(project, holder.runId)}>
												{holder.label}
											</AppLink>
											<Chip>{holder.state}</Chip>
											<span style={{ color: "var(--mfw-fg-muted)" }}>
												held since <RelativeTime value={holder.lockedAt} />
											</span>
											<span className="flex-1" />
											<Button
												size="xs"
												variant="ghost"
												onClick={() =>
													setRelease({ resource, slot: holder.slot })
												}
											>
												Force release
											</Button>
										</li>
									))}
								</ul>
							)}
						</li>
					))}
				</ul>
			)}

			{form ? (
				<div
					className="mt-3 flex flex-col gap-3 border p-3"
					style={{
						borderColor: "var(--mfw-border)",
						borderRadius: "var(--mfw-radius-md)",
						background: "var(--mfw-bg-subtle)",
					}}
				>
					<div className="grid gap-3 sm:grid-cols-2">
						<Setting
							label="id"
							hint="Stable and unique. Re-using an existing id updates that resource."
						>
							<Input
								aria-label="Resource id"
								placeholder="gpu"
								autoComplete="off"
								spellCheck={false}
								value={form.id}
								onChange={(e) => setForm({ ...form, id: e.target.value })}
							/>
						</Setting>
						<Setting
							label="name"
							hint="Shown in run views. Defaults to the id."
						>
							<Input
								aria-label="Resource name"
								placeholder="Local GPU"
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</Setting>
						<Setting
							label="capacity"
							hint="Maximum simultaneous users. Lowering it does not interrupt current work."
						>
							<Input
								type="number"
								min={1}
								className="max-w-32"
								aria-label="Resource max concurrent"
								value={form.maxConcurrent}
								onChange={(e) =>
									setForm({ ...form, maxConcurrent: e.target.value })
								}
							/>
						</Setting>
						<div className="flex flex-wrap items-end gap-3">
							<Setting label="type">
								<Select
									ariaLabel="Resource type"
									value={form.type}
									options={["fixed", "dynamic"]}
									onChange={(v) =>
										setForm({ ...form, type: v as RegisterForm["type"] })
									}
								/>
							</Setting>
							<Setting label="cost">
								<Select
									ariaLabel="Resource cost"
									value={form.cost}
									options={["free", "paid"]}
									onChange={(v) =>
										setForm({ ...form, cost: v as RegisterForm["cost"] })
									}
								/>
							</Setting>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<span
							style={{
								color: "var(--mfw-fg-faint)",
								fontSize: "var(--mfw-text-2xs)",
							}}
						>
							Policy and metadata are free-form JSON and have no editor here;
							they are preserved as-is when you edit an existing resource.
						</span>
						<span className="flex-1" />
						<Button
							size="sm"
							variant="ghost"
							disabled={registerMutation.isPending}
							onClick={() => setForm(null)}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							disabled={formInvalid || registerMutation.isPending}
							onClick={() =>
								registerMutation.mutate({
									project,
									id: form.id.trim(),
									name: form.name.trim() || undefined,
									type: form.type,
									cost: form.cost,
									maxConcurrent: Number(form.maxConcurrent),
									policy: form.policy,
									metadata: form.metadata,
								})
							}
						>
							{registerMutation.isPending ? "Saving…" : "Save resource"}
						</Button>
					</div>
				</div>
			) : null}

			<ConfirmDialog
				open={release !== null}
				onOpenChange={(open) => {
					if (!open) setRelease(null);
				}}
				title="Force release held capacity"
				confirmText={release?.resource.id}
				confirmLabel="Force release"
				pending={releaseMutation.isPending}
				description={
					release === null ? null : release.slot === undefined ? (
						<>
							Frees all {release.resource.holders.length} slot
							{release.resource.holders.length === 1 ? "" : "s"} of{" "}
							<span className="mfw-num">{release.resource.id}</span>. Active
							runs continue, and new runs may use the freed capacity
							immediately.
						</>
					) : (
						<>
							Frees slot {release.slot} of{" "}
							<span className="mfw-num">{release.resource.id}</span>. The active
							run continues.
						</>
					)
				}
				onConfirm={() => {
					if (!release) return;
					releaseMutation.mutate({
						project,
						resourceId: release.resource.id,
						slot: release.slot,
					});
				}}
			/>

			<ConfirmDialog
				open={unregister !== null}
				onOpenChange={(open) => {
					if (!open) setUnregister(null);
				}}
				title="Remove this resource"
				confirmText={unregister?.id}
				confirmLabel="Remove"
				pending={unregisterMutation.isPending}
				description={
					unregister === null ? null : (
						<>
							Removes <span className="mfw-num">{unregister.id}</span>
							{unregister.holders.length > 0 ? (
								<>
									{" "}
									and force-releases the {unregister.holders.length} slot
									{unregister.holders.length === 1 ? "" : "s"} currently held
								</>
							) : null}
							. Anything that asks for this resource afterwards will no longer
							be limited by it.
						</>
					)
				}
				onConfirm={() => {
					if (!unregister) return;
					unregisterMutation.mutate({ project, resourceId: unregister.id });
				}}
			/>
		</Panel>
	);
}
