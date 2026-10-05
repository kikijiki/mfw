import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Trash2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { MarkdownField } from "../../components/MarkdownField";
import { Panel } from "../../components/Page";
import { type TRPCError, useTRPC } from "../../lib/trpc";
import { attachmentUrl, humanSize, isImageAttachment } from "./attachments";

const faint = { color: "var(--mfw-fg-faint)" } as const;

/** The task's optional spec.md: rendered, with an explicit edit/save loop. */
export function SpecPanel({
	project,
	taskId,
	knownTaskIds,
}: {
	project: string;
	taskId: string;
	knownTaskIds: Set<string>;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const specQuery = useQuery(
		trpc.tasks.getSpec.queryOptions({ project, id: taskId }),
	);
	// null = not editing; the server copy is shown as-is.
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const spec = specQuery.data;

	const save = useMutation(
		trpc.tasks.setSpec.mutationOptions({
			meta: { label: "Save spec" },
			onSuccess: () => {
				setDraft(null);
				setError(null);
				setConflict(false);
				void queryClient.invalidateQueries(
					trpc.tasks.getSpec.queryFilter({ project, id: taskId }),
				);
			},
			onError: (e: TRPCError) => {
				setError(e.message);
				if (e.data?.code === "CONFLICT") setConflict(true);
				// Reload the server copy but keep the draft: nothing is discarded.
				void queryClient.invalidateQueries(
					trpc.tasks.getSpec.queryFilter({ project, id: taskId }),
				);
			},
		}),
	);

	const dirty = draft !== null && draft !== (spec?.body ?? "");
	const doSave = () =>
		spec &&
		draft !== null &&
		save.mutate({ project, id: taskId, body: draft, baseHash: spec.hash });

	return (
		<Panel title="Spec">
			{specQuery.isLoading ? (
				<LoadingRows rows={2} />
			) : specQuery.error || !spec ? (
				<ErrorState
					title="Could not load the spec"
					error={specQuery.error}
					onRetry={() => void specQuery.refetch()}
				/>
			) : !spec.exists && draft === null ? (
				<Button size="sm" variant="ghost" onClick={() => setDraft("")}>
					Add a spec
				</Button>
			) : (
				<div className="flex flex-col gap-2">
					<MarkdownField
						value={draft ?? spec.body}
						onChange={setDraft}
						project={project}
						knownTaskIds={knownTaskIds}
						rows={14}
						ariaLabel="Spec (markdown)"
						placeholder="Requirements, constraints, decisions. Reference attachments as files/name.png."
						attachmentTaskId={taskId}
					/>
					{error ? (
						<p
							role="alert"
							className="flex items-start gap-2"
							style={{ color: "var(--mfw-warn)" }}
						>
							<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
							<span className="min-w-0 break-words">
								{conflict
									? `${error} Your text is still here; the latest saved version has been loaded.`
									: error}
							</span>
						</p>
					) : null}
					{draft !== null ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								disabled={!dirty || save.isPending}
								onClick={doSave}
							>
								{conflict ? "Keep mine" : "Save spec"}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={save.isPending}
								onClick={() => {
									setDraft(null);
									setError(null);
									setConflict(false);
								}}
							>
								{conflict ? "Reload theirs" : "Discard"}
							</Button>
							<span style={faint}>Clearing the text deletes the spec.</span>
						</div>
					) : null}
				</div>
			)}
		</Panel>
	);
}

function toBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.readAsDataURL(file);
	});
}

export function AttachmentsPanel({
	project,
	taskId,
}: {
	project: string;
	taskId: string;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const inputRef = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const list = useQuery(
		trpc.tasks.listAttachments.queryOptions({ project, id: taskId }),
	);
	const refresh = () =>
		void queryClient.invalidateQueries(
			trpc.tasks.listAttachments.queryFilter({ project, id: taskId }),
		);

	const add = useMutation(
		trpc.tasks.addAttachment.mutationOptions({
			meta: { label: "Upload attachment" },
			onSuccess: refresh,
		}),
	);
	const remove = useMutation(
		trpc.tasks.removeAttachment.mutationOptions({
			meta: { label: "Remove attachment" },
			onSuccess: refresh,
			onError: (e: TRPCError) => setError(e.message),
		}),
	);

	const upload = async (files: FileList | File[]) => {
		setError(null);
		for (const file of Array.from(files)) {
			try {
				const dataBase64 = await toBase64(file);
				await add.mutateAsync({
					project,
					id: taskId,
					name: file.name,
					dataBase64,
				});
			} catch (e) {
				setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
				break;
			}
		}
		if (inputRef.current) inputRef.current.value = "";
	};

	return (
		<Panel title="Attachments">
			{list.isLoading ? (
				<LoadingRows rows={2} />
			) : list.error ? (
				<ErrorState
					title="Could not load attachments"
					error={list.error}
					onRetry={() => void list.refetch()}
				/>
			) : (
				<div className="flex flex-col gap-2">
					{list.data?.length ? (
						<ul className="flex flex-col gap-2">
							{list.data.map((file) => (
								<li key={file.name} className="flex min-w-0 items-center gap-2">
									{isImageAttachment(file.name) ? (
										<img
											src={attachmentUrl(project, taskId, file.name)}
											alt=""
											className="size-10 shrink-0 rounded object-cover"
										/>
									) : (
										<Paperclip aria-hidden className="size-4 shrink-0" />
									)}
									<a
										href={attachmentUrl(project, taskId, file.name)}
										target="_blank"
										rel="noreferrer"
										className="min-w-0 flex-1 truncate underline"
										title={file.name}
									>
										{file.name}
									</a>
									<span className="shrink-0" style={faint}>
										{humanSize(file.size)}
									</span>
									<Button
										size="icon"
										variant="ghost"
										aria-label={`Delete attachment ${file.name}`}
										disabled={remove.isPending}
										onClick={() =>
											remove.mutate({ project, id: taskId, name: file.name })
										}
									>
										<Trash2 aria-hidden className="size-4" />
									</Button>
								</li>
							))}
						</ul>
					) : (
						<p style={faint}>No attachments.</p>
					)}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; the file input below is the accessible path */}
					<div
						className="flex flex-col gap-1 rounded border border-dashed p-2"
						style={{
							borderColor: dragging ? "var(--mfw-accent)" : "var(--mfw-border)",
						}}
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragging(false);
							void upload(e.dataTransfer.files);
						}}
					>
						<label className="flex flex-col gap-1">
							<span>Add files (or drop them here)</span>
							<input
								ref={inputRef}
								type="file"
								multiple
								disabled={add.isPending}
								onChange={(e) => e.target.files && void upload(e.target.files)}
							/>
						</label>
						<span style={faint}>
							5 MiB per file, 25 MiB total. Reference in markdown as files/name.
						</span>
					</div>
					{add.isPending ? <p style={faint}>Uploading...</p> : null}
					{error ? (
						<p role="alert" style={{ color: "var(--mfw-warn)" }}>
							{error}
						</p>
					) : null}
				</div>
			)}
		</Panel>
	);
}
