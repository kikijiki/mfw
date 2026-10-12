import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import {
	type DocSourceInput,
	deriveSourceId,
	describeSource,
	sourceProblem,
	splitGlobs,
} from "./sourceDraft";

const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;
const selectClass =
	"mfw-focus h-8 rounded-md border bg-transparent px-2 text-sm";

/**
 * The documentation directories of a project: those enabled, the conventional
 * ones found on disk but not enabled yet (an explicit "Add"), and a form for
 * any other directory. Saves through `settings.update({docs})`, which the
 * daemon validates (paths stay inside the repository or board folder) and
 * applies on the next Docs request.
 */
export function DocSourcesManager({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const settings = useQuery(trpc.settings.get.queryOptions({ project }));
	const suggestions = useQuery(trpc.docs.suggestions.queryOptions({ project }));
	const configured: DocSourceInput[] = settings.data?.values.docs ?? [];

	const [label, setLabel] = useState("");
	const [path, setPath] = useState("");
	const [base, setBase] = useState<"repo" | "board">("repo");
	const [include, setInclude] = useState("");
	const [exclude, setExclude] = useState("");

	const save = useMutation(
		trpc.settings.update.mutationOptions({
			meta: { label: "Save doc sources" },
			onSuccess: () => {
				toast({ tone: "success", title: "Doc sources saved" });
				setLabel("");
				setPath("");
				setInclude("");
				setExclude("");
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.settings.get.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.docs.suggestions.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.docs.sources.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(
					trpc.docs.entries.queryFilter({ project }),
				);
			},
		}),
	);
	const write = (next: DocSourceInput[]) =>
		save.mutate({ project, patch: { docs: next } });

	if (settings.isError) {
		return (
			<ErrorState
				title="Could not read the doc sources"
				error={settings.error}
				onRetry={() => void settings.refetch()}
			/>
		);
	}
	if (settings.isLoading) return <LoadingRows rows={3} />;

	const problem = sourceProblem({ label, path });
	const taken = configured.map((s) => s.id);

	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-2">
				<h3 style={{ ...muted, ...small }}>Enabled directories</h3>
				{configured.length === 0 ? (
					<p style={{ ...muted, ...small }}>
						None yet. Board documents (ADRs, specs, journals) are always listed;
						add the directories your repository keeps documentation in.
					</p>
				) : (
					<ul className="flex flex-col gap-1">
						{configured.map((s) => (
							<li
								key={s.id}
								className="flex items-center gap-2 rounded border px-2 py-1.5"
								style={{ borderColor: "var(--mfw-border)" }}
							>
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-medium">{s.label}</span>
									<span
										className="truncate mfw-num"
										style={{ ...muted, ...small }}
									>
										{describeSource(s)}
									</span>
								</div>
								{s.kind ? <Chip>{s.kind}</Chip> : null}
								<Button
									size="icon-xs"
									variant="ghost"
									aria-label={`Stop listing ${s.label}`}
									title="Stop listing this directory (files stay where they are)"
									disabled={save.isPending}
									onClick={() => write(configured.filter((c) => c.id !== s.id))}
								>
									<Trash2 aria-hidden />
								</Button>
							</li>
						))}
					</ul>
				)}
			</section>

			{(suggestions.data ?? []).length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 style={{ ...muted, ...small }}>Found in the repository</h3>
					<ul className="flex flex-col gap-1">
						{(suggestions.data ?? []).map((s) => (
							<li
								key={s.id}
								className="flex items-center gap-2 rounded border border-dashed px-2 py-1.5"
								style={{ borderColor: "var(--mfw-border)" }}
							>
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-medium">{s.label}</span>
									<span className="truncate" style={{ ...muted, ...small }}>
										{s.reason}
									</span>
								</div>
								<Button
									size="sm"
									variant="outline"
									disabled={save.isPending}
									onClick={() =>
										write([
											...configured,
											{
												id: s.id,
												label: s.label,
												path: s.path,
												...(s.base === "board"
													? { base: "board" as const }
													: {}),
												...(s.include ? { include: s.include } : {}),
												...(s.kind ? { kind: s.kind } : {}),
											},
										])
									}
								>
									<Plus aria-hidden /> Add
								</Button>
							</li>
						))}
					</ul>
				</section>
			) : null}

			<form
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (problem) return;
					const inc = splitGlobs(include);
					const exc = splitGlobs(exclude);
					write([
						...configured,
						{
							id: deriveSourceId(label, taken),
							label: label.trim(),
							path: path.trim().replace(/\\/g, "/").replace(/\/+$/, "") || ".",
							...(base === "board" ? { base } : {}),
							...(inc.length ? { include: inc } : {}),
							...(exc.length ? { exclude: exc } : {}),
						},
					]);
				}}
			>
				<h3 style={{ ...muted, ...small }}>Add a directory</h3>
				<div className="flex flex-wrap gap-2">
					<Input
						className="min-w-40 flex-1"
						aria-label="Name"
						placeholder="Name (Design notes)"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
					/>
					<Input
						className="min-w-40 flex-1"
						aria-label="Directory"
						placeholder="Directory (docs/design)"
						value={path}
						onChange={(e) => setPath(e.target.value)}
					/>
					<select
						className={selectClass}
						aria-label="Relative to"
						value={base}
						onChange={(e) => setBase(e.target.value as "repo" | "board")}
					>
						<option value="repo">in the repository</option>
						<option value="board">in the board folder</option>
					</select>
				</div>
				<div className="flex flex-wrap gap-2">
					<Input
						className="min-w-40 flex-1"
						aria-label="Only these files"
						placeholder="Only (optional): **/*.md, **/*.mmd"
						value={include}
						onChange={(e) => setInclude(e.target.value)}
					/>
					<Input
						className="min-w-40 flex-1"
						aria-label="Except these files"
						placeholder="Except (optional): drafts/**"
						value={exclude}
						onChange={(e) => setExclude(e.target.value)}
					/>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="submit"
						size="sm"
						disabled={problem !== null || save.isPending}
					>
						<FolderPlus aria-hidden /> Add directory
					</Button>
					{label !== "" || path !== "" ? (
						<span style={{ ...muted, ...small }}>{problem}</span>
					) : null}
				</div>
				<p style={{ ...muted, ...small }}>
					Markdown, text, Mermaid (.mmd), PlantUML (.puml), SVG and PNG/JPEG
					files are listed by default. Paths stay inside the repository or the
					board folder, and ignored files are never listed.
				</p>
			</form>
		</div>
	);
}
