import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { MarkdownField } from "~/components/MarkdownField";
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
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Cost";
import { ErrorState } from "../../components/ErrorState";
import { Chip, Panel } from "../../components/Page";
import { useGo } from "../../lib/nav";
import { useToast } from "../../lib/toast";
import type { RouterOutputs, TRPCError } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

type Adr = RouterOutputs["adrs"]["list"][number];

interface Draft {
	title: string;
	body: string;
}

const NEW_BODY =
	"## Context\n\nWhat is the issue that motivates this decision?\n\n## Decision\n\nWhat we are going to do.\n\n## Consequences\n\nWhat becomes easier or harder as a result.\n";

const toDraft = (adr: Adr): Draft => ({ title: adr.title, body: adr.body });

/**
 * The ADR create / edit / accept / supersede flows, mounted by the Docs page.
 *
 * It renders the editor for `selectedId` (nothing when that is undefined, which
 * is when the reader shows some other document) and always owns the create
 * dialog, so "New ADR" works from anywhere in Docs. Rules (frozen once
 * accepted, `baseHash` conflicts) are the daemon's; this is the form over them.
 * The parent supplies a flex column: the editor scrolls, the save bars sit at
 * the bottom.
 */
export function AdrEditor({
	project,
	selectedId,
	creating,
	setCreating,
}: {
	project: string;
	/** The ADR open in the reader, if the reader is showing one. */
	selectedId?: string;
	creating: { supersedes: string | null } | false;
	setCreating: (next: { supersedes: string | null } | false) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const go = useGo();
	const { toast } = useToast();
	const adrsQuery = useQuery(trpc.adrs.list.queryOptions({ project }));
	const tasksQuery = useQuery(trpc.tasks.list.queryOptions({ project }));
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [createTitle, setCreateTitle] = useState("");
	const [createBody, setCreateBody] = useState(NEW_BODY);

	const adrs = adrsQuery.data ?? [];
	const selected = adrs.find((adr) => adr.id === selectedId) ?? null;
	const editable = selected?.status === "proposed" && !selected.error;

	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [base, setBase] = useState<Draft | null>(null);
	const [baseHash, setBaseHash] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
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
			!window.confirm("Discard the unsaved changes to this ADR?"),
	});

	useEffect(() => {
		if (!selected) {
			setEditingId(null);
			setDraft(null);
			setBase(null);
			setBaseHash(null);
			return;
		}
		if (
			editingId === selected.id &&
			draft !== null &&
			(dirty || selected.hash === baseHash)
		) {
			return;
		}
		const next = toDraft(selected);
		setEditingId(selected.id);
		setDraft(next);
		setBase(next);
		setBaseHash(selected.hash);
		setConflict(false);
	}, [selected, editingId, draft, dirty, baseHash]);

	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries(trpc.adrs.list.queryFilter({ project })),
			// The Docs tree and reader show the same documents.
			queryClient.invalidateQueries(trpc.docs.sources.queryFilter({ project })),
			queryClient.invalidateQueries(trpc.docs.entries.queryFilter({ project })),
			queryClient.invalidateQueries(trpc.docs.read.queryFilter({ project })),
		]);

	const resetCreate = () => {
		setCreating(false);
		setCreateTitle("");
		setCreateBody(NEW_BODY);
	};

	const create = useMutation(
		trpc.adrs.create.mutationOptions({
			meta: { label: "Create ADR" },
			onSuccess: (created) => {
				resetCreate();
				void refresh();
				toast({ tone: "success", title: `${created.id} created` });
				go(href.adr(project, created.id));
			},
		}),
	);
	const supersede = useMutation(
		trpc.adrs.supersede.mutationOptions({
			meta: { label: "Supersede ADR" },
			onSuccess: ({ next, old }) => {
				resetCreate();
				void refresh();
				toast({
					tone: "success",
					title: `${next.id} supersedes ${old.id}`,
				});
				go(href.adr(project, next.id));
			},
		}),
	);
	const save = useMutation(
		trpc.adrs.update.mutationOptions({
			meta: { label: "Save ADR" },
			onSuccess: (updated) => {
				const next = toDraft(updated);
				setDraft(next);
				setBase(next);
				setBaseHash(updated.hash);
				setConflict(false);
				void refresh();
				toast({ tone: "success", title: `${updated.id} saved` });
				// The slug follows the title; the id in the URL is stable.
			},
			onError: (error: TRPCError) => {
				if (error.data?.code === "CONFLICT") {
					setConflict(true);
					void refresh();
				}
			},
		}),
	);
	const decide = useMutation(
		trpc.adrs.setStatus.mutationOptions({
			meta: { label: "Change ADR status" },
			onSuccess: (updated) => {
				void refresh();
				toast({ tone: "success", title: `${updated.id} ${updated.status}` });
			},
			onError: (error: TRPCError) => {
				if (error.data?.code === "CONFLICT") {
					setConflict(true);
					void refresh();
				}
			},
		}),
	);
	const remove = useMutation(
		trpc.adrs.remove.mutationOptions({
			meta: { label: "Delete ADR" },
			onSuccess: () => {
				setConfirmingDelete(false);
				void refresh();
				if (selected)
					toast({ tone: "success", title: `${selected.id} deleted` });
				go(href.docs(project, { source: "adr" }));
			},
		}),
	);

	const doSave = (overrideHash?: string) => {
		if (!selected || !draft || baseHash === null || draft.title.trim() === "")
			return;
		save.mutate({
			project,
			id: selected.id,
			baseHash: overrideHash ?? baseHash,
			patch: { title: draft.title.trim(), body: draft.body },
		});
	};
	const serverMovedOn =
		selected !== null && baseHash !== null && selected.hash !== baseHash;
	const knownTaskIds = new Set((tasksQuery.data ?? []).map((task) => task.id));
	const canDelete =
		selected?.status === "proposed" || selected?.status === "rejected";
	const supersedingOf = creating ? creating.supersedes : null;
	const submitting = create.isPending || supersede.isPending;

	const adrLink = (id: string | null) =>
		id ? (
			<AppLink to={href.adr(project, id)} className="mfw-num">
				{id}
			</AppLink>
		) : null;

	return (
		<>
			<Dialog
				open={creating !== false}
				onOpenChange={(open) => !open && resetCreate()}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{supersedingOf ? `Supersede ${supersedingOf}` : "New ADR"}
						</DialogTitle>
						<DialogDescription>
							{supersedingOf
								? `The new ADR starts as proposed. ${supersedingOf} is marked superseded right away and stays as history.`
								: "Record a decision. It stays editable until it is accepted."}
						</DialogDescription>
					</DialogHeader>
					<Input
						autoFocus
						aria-label="Title"
						placeholder="Title"
						value={createTitle}
						onChange={(event) => setCreateTitle(event.target.value)}
					/>
					<MarkdownField
						value={createBody}
						onChange={setCreateBody}
						project={project}
						knownTaskIds={knownTaskIds}
						rows={12}
						ariaLabel="ADR body"
					/>
					<DialogFooter>
						<Button variant="ghost" disabled={submitting} onClick={resetCreate}>
							Cancel
						</Button>
						<Button
							disabled={submitting || createTitle.trim() === ""}
							onClick={() =>
								supersedingOf
									? supersede.mutate({
											project,
											id: supersedingOf,
											title: createTitle.trim(),
											body: createBody,
										})
									: create.mutate({
											project,
											title: createTitle.trim(),
											body: createBody,
										})
							}
						>
							{submitting ? "Creating…" : "Create"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{selected && draft ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
					<Panel
						title={
							<span className="flex items-center gap-2">
								<Mono value={selected.id} />
								<Chip>{selected.status}</Chip>
							</span>
						}
						actions={
							<span className="flex items-center gap-1">
								{selected.status === "proposed" && !selected.error ? (
									<>
										<Button
											size="sm"
											variant="outline"
											disabled={decide.isPending || dirty}
											title={dirty ? "Save or discard your edits first" : ""}
											onClick={() =>
												decide.mutate({
													project,
													id: selected.id,
													status: "rejected",
													baseHash: selected.hash,
												})
											}
										>
											Reject
										</Button>
										<Button
											size="sm"
											disabled={decide.isPending || dirty}
											title={dirty ? "Save or discard your edits first" : ""}
											onClick={() =>
												decide.mutate({
													project,
													id: selected.id,
													status: "accepted",
													baseHash: selected.hash,
												})
											}
										>
											Accept
										</Button>
									</>
								) : null}
								{selected.status === "accepted" ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setCreateTitle(selected.title);
											setCreateBody(selected.body);
											setCreating({ supersedes: selected.id });
										}}
									>
										Supersede…
									</Button>
								) : null}
								{canDelete ? (
									<Button
										size="icon-xs"
										variant="ghost"
										aria-label={`Delete ${selected.id}`}
										onClick={() => setConfirmingDelete(true)}
									>
										<Trash2 aria-hidden />
									</Button>
								) : null}
							</span>
						}
					>
						<div className="flex flex-col gap-3">
							{selected.error ? (
								<p style={{ color: "var(--mfw-warn)" }}>
									{selected.fileName} could not be parsed ({selected.error}).
									Fix the file in your editor.
								</p>
							) : null}
							{!editable && !selected.error ? (
								<p style={{ color: "var(--mfw-fg-muted)" }}>
									{selected.status === "accepted"
										? "Accepted ADRs are frozen: the record of a decision is not rewritten. To change the decision, supersede it with a new ADR."
										: `${selected.status[0]?.toUpperCase()}${selected.status.slice(1)} ADRs are read-only.`}
								</p>
							) : null}
							<Input
								aria-label="Title"
								value={draft.title}
								disabled={!editable}
								onChange={(event) =>
									setDraft({ ...draft, title: event.target.value })
								}
							/>
							<MarkdownField
								value={draft.body}
								onChange={(body) => setDraft({ ...draft, body })}
								project={project}
								knownTaskIds={knownTaskIds}
								rows={18}
								ariaLabel="ADR body"
								disabled={!editable}
							/>
							<span
								className="flex flex-wrap gap-3"
								style={{
									color: "var(--mfw-fg-faint)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								<span>{selected.date}</span>
								{selected.supersedes ? (
									<span>supersedes {adrLink(selected.supersedes)}</span>
								) : null}
								{selected.supersededBy ? (
									<span>superseded by {adrLink(selected.supersededBy)}</span>
								) : null}
							</span>
						</div>
					</Panel>
				</div>
			) : selectedId && !adrsQuery.isLoading ? (
				<div className="min-w-0 flex-1 p-3">
					<ErrorState
						title="No such ADR"
						error={`${selectedId} does not exist in ${project}.`}
					/>
				</div>
			) : null}

			{selected ? (
				<ConfirmDialog
					open={confirmingDelete}
					onOpenChange={setConfirmingDelete}
					title="Delete this ADR"
					description={
						<>
							Removes <span className="mfw-num">{selected.id}</span>. Only
							proposed and rejected ADRs can be deleted.
						</>
					}
					confirmText={selected.id}
					confirmLabel="Delete ADR"
					pending={remove.isPending}
					onConfirm={() => remove.mutate({ project, id: selected.id })}
				/>
			) : null}

			{(conflict || (serverMovedOn && dirty)) && selected && editable ? (
				<div
					className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2"
					style={{
						borderColor:
							"color-mix(in oklch, var(--mfw-warn) 40%, transparent)",
						background: "color-mix(in oklch, var(--mfw-warn) 14%, transparent)",
					}}
				>
					<TriangleAlert
						aria-hidden
						className="size-4"
						style={{ color: "var(--mfw-warn)" }}
					/>
					<span className="min-w-0 flex-1">
						This ADR changed while you were editing. Your edits are still here.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							const next = toDraft(selected);
							setDraft(next);
							setBase(next);
							setBaseHash(selected.hash);
							setConflict(false);
						}}
					>
						Reload theirs
					</Button>
					<Button
						size="sm"
						disabled={save.isPending}
						onClick={() => doSave(selected.hash)}
					>
						Keep mine
					</Button>
				</div>
			) : null}

			{dirty ? (
				<div
					className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2"
					style={{
						borderColor: "var(--mfw-border)",
						background: "var(--mfw-bg-subtle)",
					}}
				>
					<span style={{ color: "var(--mfw-warn)" }}>Unsaved changes</span>
					<span className="flex-1" />
					<Button
						size="sm"
						variant="ghost"
						disabled={save.isPending}
						onClick={() => base && setDraft(base)}
					>
						Discard
					</Button>
					<Button
						size="sm"
						disabled={save.isPending || draft?.title.trim() === ""}
						onClick={() => doSave()}
					>
						{save.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			) : null}
		</>
	);
}
