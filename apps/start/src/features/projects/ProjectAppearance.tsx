import {
	isProjectTextMark,
	PROJECT_COLOR_KEYS,
	PROJECT_ICON_KEYS,
	PROJECT_MARK_MAX,
	type ProjectColorKey,
	type ProjectIconKey,
	resolveAvatar,
} from "@mfw/daemon/project-appearance";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Tip } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { Panel } from "../../components/Page";
import { humanizeError, useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import {
	PROJECT_ICONS,
	ProjectAvatar,
	useProjectAppearances,
} from "./ProjectAvatar";

/**
 * Pick how a project looks when the rail is collapsed: a curated glyph or a
 * 1-2 character mark of your own, on one of ten muted swatches. Unset means
 * the monogram and colour derived from the name.
 */

interface Draft {
	icon: string | null;
	color: string | null;
}

/** Empty or invalid mark input is "no icon"; the daemon validates the rest. */
export function markProblem(text: string): string | null {
	if (text === "") return null;
	return isProjectTextMark(text)
		? null
		: `A mark is 1-${PROJECT_MARK_MAX} characters with no spaces.`;
}

function AppearanceEditor({
	project,
	onSaved,
	onCancel,
}: {
	project: string;
	onSaved?: () => void;
	onCancel?: () => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const current = useProjectAppearances().get(project);
	const base: Draft = {
		icon: current?.icon ?? null,
		color: current?.color ?? null,
	};
	const [draft, setDraft] = useState<Draft>(base);
	const [mark, setMark] = useState("");
	// Adopt the stored value once it arrives, but never overwrite an edit.
	const [touched, setTouched] = useState(false);
	useEffect(() => {
		if (touched) return;
		setDraft({ icon: current?.icon ?? null, color: current?.color ?? null });
	}, [current?.icon, current?.color, touched]);
	useEffect(() => {
		if (draft.icon && !(draft.icon in PROJECT_ICONS)) setMark(draft.icon);
	}, [draft.icon]);

	const save = useMutation(
		trpc.settings.update.mutationOptions({
			meta: { toast: false },
			onSuccess: () => {
				toast({ tone: "success", title: `${project} appearance saved` });
				onSaved?.();
			},
			onError: (error) =>
				toast({
					tone: "error",
					title: "Could not save the appearance",
					description: humanizeError(error),
				}),
			onSettled: () => {
				void queryClient.invalidateQueries(trpc.system.projects.queryFilter());
				void queryClient.invalidateQueries(
					trpc.settings.get.queryFilter({ project }),
				);
			},
		}),
	);

	const edit = (next: Partial<Draft>) => {
		setTouched(true);
		setDraft((d) => ({ ...d, ...next }));
	};
	const problem = markProblem(mark);
	const dirty = draft.icon !== base.icon || draft.color !== base.color;
	const resolved = resolveAvatar(project, draft);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-start gap-6">
				<fieldset className="m-0 min-w-0 flex-1 border-0 p-0">
					<legend
						className="mb-1.5 p-0"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						Icon
					</legend>
					<div className="flex flex-wrap gap-1">
						{PROJECT_ICON_KEYS.map((key) => {
							const Icon = PROJECT_ICONS[key as ProjectIconKey];
							const on = draft.icon === key;
							return (
								<Tip key={key} label={key}>
									<button
										type="button"
										aria-label={key}
										aria-pressed={on}
										className="mfw-focus inline-flex size-8 items-center justify-center border"
										style={{
											background: on
												? "var(--mfw-accent-subtle)"
												: "transparent",
											borderColor: on
												? "var(--mfw-accent)"
												: "var(--mfw-border)",
											color: on ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
											borderRadius: "var(--mfw-radius-md)",
										}}
										onClick={() => {
											setMark("");
											edit({ icon: key });
										}}
									>
										<Icon aria-hidden className="size-4" />
									</button>
								</Tip>
							);
						})}
					</div>
					<div
						className="mt-2 flex items-center gap-2"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						<span>or a mark</span>
						<Input
							value={mark}
							maxLength={8}
							placeholder="e.g. K9"
							aria-label="Text mark"
							aria-invalid={problem !== null}
							className="w-20"
							onChange={(e) => {
								const v = e.target.value;
								setMark(v);
								if (v === "") edit({ icon: null });
								else if (markProblem(v) === null) edit({ icon: v });
							}}
						/>
						<span>
							{problem ?? "1-2 letters or digits, or an emoji you type."}
						</span>
					</div>
				</fieldset>

				<fieldset className="m-0 border-0 p-0">
					<legend
						className="mb-1.5 p-0"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						Colour
					</legend>
					<div className="flex max-w-[11rem] flex-wrap gap-1.5">
						{PROJECT_COLOR_KEYS.map((key) => {
							const on = draft.color === key;
							return (
								<Tip key={key} label={key}>
									<button
										type="button"
										aria-label={key}
										aria-pressed={on}
										data-swatch={key}
										className={cn(
											"mfw-swatch mfw-focus size-7 border-2",
											on ? "" : "border-transparent",
										)}
										style={{
											borderRadius: "var(--mfw-radius-md)",
											borderColor: on ? "var(--mfw-fg)" : undefined,
										}}
										onClick={() => edit({ color: key as ProjectColorKey })}
									/>
								</Tip>
							);
						})}
					</div>
				</fieldset>

				<div className="flex flex-col gap-2">
					<span
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						Preview
					</span>
					<div className="flex items-center gap-3">
						<span
							className="inline-flex size-9 items-center justify-center border p-0.5"
							style={{
								borderColor: "var(--mfw-accent)",
								background: "var(--mfw-accent-subtle)",
								borderRadius: "var(--mfw-radius-md)",
							}}
						>
							<ProjectAvatar name={project} appearance={draft} size={28} />
						</span>
						<span
							className="inline-flex h-9 min-w-36 items-center gap-2 px-2"
							style={{
								background: "var(--mfw-accent-subtle)",
								borderRadius: "var(--mfw-radius-md)",
								color: "var(--mfw-accent)",
							}}
						>
							<ProjectAvatar name={project} appearance={draft} size={22} />
							<span className="truncate">{project}</span>
						</span>
					</div>
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						{resolved.custom
							? "Your choice"
							: "Default: monogram from the name"}
					</span>
				</div>
			</div>

			<div className="flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					disabled={!dirty || problem !== null || save.isPending}
					onClick={() =>
						save.mutate({
							project,
							patch: { icon: draft.icon, color: draft.color },
						})
					}
				>
					{save.isPending ? "Saving…" : "Save appearance"}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={draft.icon === null && draft.color === null}
					onClick={() => {
						setMark("");
						edit({ icon: null, color: null });
					}}
				>
					Use default
				</Button>
				{onCancel ? (
					<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				) : null}
			</div>
		</div>
	);
}

/** One row at the top of project settings; the picker opens in a dialog only when asked for. */
export function ProjectAppearanceCard({ project }: { project: string }) {
	const [open, setOpen] = useState(false);
	const current = useProjectAppearances().get(project);
	const custom = Boolean(current?.icon || current?.color);
	return (
		<Panel id="appearance" title="Appearance">
			<div className="flex items-center gap-3">
				<ProjectAvatar name={project} appearance={current} size={28} />
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					{custom
						? "Custom icon and colour"
						: "Default: monogram from the name"}
				</span>
				<span className="flex-1" />
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => setOpen(true)}
				>
					Customize
				</Button>
			</div>
			<ProjectAppearanceDialog
				project={project}
				open={open}
				onOpenChange={setOpen}
			/>
		</Panel>
	);
}

/** The same picker from the rail/row menu's "Change icon..." item. */
export function ProjectAppearanceDialog({
	project,
	open,
	onOpenChange,
}: {
	project: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Change icon for {project}</DialogTitle>
					<DialogDescription>
						Shown in the collapsed sidebar, the project list and the presence
						bar.
					</DialogDescription>
				</DialogHeader>
				{open ? (
					<AppearanceEditor
						project={project}
						onSaved={() => onOpenChange(false)}
						onCancel={() => onOpenChange(false)}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
