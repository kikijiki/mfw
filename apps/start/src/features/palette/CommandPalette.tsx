import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { useMemo, useState } from "react";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { ShortcutKbd } from "../../components/ShortcutKbd";
import { useKeyBindings } from "../../lib/keyboard";
import { useGo } from "../../lib/nav";
import { nodeRef } from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import {
	commandsOnly,
	filterCommands,
	navCommands,
	nodeTarget,
	type PaletteCommand,
	type PaletteTask,
	paletteBindings,
	rankTasks,
	refFromQuery,
} from "./palette";

/**
 * Mod+K: jump to a task (by id or title), open a node ref typed whole, or run a
 * navigation command. Also owns the global `g h` / `g b` / `g f` sequences, so
 * it is mounted once, in the root shell, and is always listening.
 *
 * Filtering is `palette.ts`, not cmdk's own (`shouldFilter={false}`): the
 * ranking is unit-tested and an id hit must beat a title hit.
 */
export function CommandPalette({ project }: { project?: string }) {
	const [open, setOpen] = useState(false);
	const go = useGo();
	const trpc = useTRPC();
	const projects = useQuery({
		...trpc.system.projects.queryOptions(),
		staleTime: 5 * 60_000,
	});
	// The route's project, else the first attached one, so `g b` works from Home.
	const active = project ?? projects.data?.[0]?.name ?? null;

	useKeyBindings(
		paletteBindings({
			project: active,
			go: (to) => go(to),
			open: () => setOpen(true),
		}),
	);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				showCloseButton={false}
				className="mfw-v2 top-[20%] translate-y-0 gap-0 p-0 sm:max-w-xl"
			>
				<DialogTitle className="sr-only">Command palette</DialogTitle>
				<DialogDescription className="sr-only">
					Jump to a task, or run a command.
				</DialogDescription>
				{open ? (
					<PaletteBody project={active} onDone={() => setOpen(false)} go={go} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** Mounted only while open, so the tasks query and the search box reset every time. */
function PaletteBody({
	project,
	go,
	onDone,
}: {
	project: string | null;
	go: (to: string) => void;
	onDone: () => void;
}) {
	const trpc = useTRPC();
	const tasks = useQuery({
		...trpc.tasks.list.queryOptions({ project: project ?? "" }),
		enabled: project !== null,
	});
	const [query, setQuery] = useState("");

	const palette = useMemo<PaletteTask[]>(
		() =>
			(tasks.data ?? []).map((t) => ({
				id: t.id,
				title: t.title,
				status: t.status,
			})),
		[tasks.data],
	);

	return (
		<PaletteList
			project={project}
			query={query}
			onQuery={setQuery}
			tasks={palette}
			loading={tasks.isPending && project !== null}
			onSelect={(to) => {
				onDone();
				go(to);
			}}
		/>
	);
}

/** The searchable list itself; no data hooks, so it renders in a test. */
export function PaletteList({
	project,
	query,
	onQuery,
	tasks,
	loading = false,
	onSelect,
}: {
	project: string | null;
	query: string;
	onQuery: (q: string) => void;
	tasks: readonly PaletteTask[];
	loading?: boolean;
	onSelect: (to: string) => void;
}) {
	const verbsOnly = commandsOnly(query);
	const commands = filterCommands(navCommands(project), query);
	const matched = !verbsOnly && project ? rankTasks(tasks, query) : [];
	const typedRef = !verbsOnly ? refFromQuery(query) : null;
	const empty =
		commands.length === 0 && matched.length === 0 && typedRef === null;

	return (
		<Command shouldFilter={false} label="Command palette" loop>
			<Command.Input
				value={query}
				onValueChange={onQuery}
				placeholder="Jump to a task, run or decision, or type > for commands"
				className="mfw-focus w-full border-b bg-transparent px-3 py-2.5 outline-none"
				style={{ borderColor: "var(--mfw-border)" }}
			/>
			<Command.List className="max-h-[50dvh] overflow-auto p-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--mfw-fg-faint)]">
				{typedRef && project ? (
					<Command.Group heading="Open">
						<Item
							value={`open ${typedRef}`}
							onSelect={() => onSelect(nodeTarget(project, typedRef))}
						>
							<span className="mfw-num">{typedRef}</span>
						</Item>
					</Command.Group>
				) : null}
				{matched.length > 0 && project ? (
					<Command.Group heading="Tasks">
						{matched.map((t) => (
							<Item
								key={t.id}
								value={`task ${t.id}`}
								onSelect={() =>
									onSelect(nodeTarget(project, nodeRef.task(t.id)))
								}
							>
								<span
									className="mfw-num shrink-0"
									style={{ color: "var(--mfw-fg-muted)" }}
								>
									{t.id}
								</span>
								<span className="min-w-0 truncate">{t.title}</span>
								<span
									className="ml-auto shrink-0"
									style={{
										color: "var(--mfw-fg-faint)",
										fontSize: "var(--mfw-text-2xs)",
									}}
								>
									{t.status}
								</span>
							</Item>
						))}
					</Command.Group>
				) : null}
				{commands.length > 0 ? (
					<Command.Group heading="Go to">
						{commands.map((c) => (
							<CommandItem key={c.id} command={c} onSelect={onSelect} />
						))}
					</Command.Group>
				) : null}
				{loading && matched.length === 0 ? (
					<div className="px-3 py-2" style={{ color: "var(--mfw-fg-faint)" }}>
						Loading tasks…
					</div>
				) : null}
				{empty && !loading ? (
					<Command.Empty className="px-3 py-6 text-center">
						Nothing matches "{query}".
					</Command.Empty>
				) : null}
			</Command.List>
		</Command>
	);
}

function CommandItem({
	command,
	onSelect,
}: {
	command: PaletteCommand;
	onSelect: (to: string) => void;
}) {
	return (
		<Item value={command.id} onSelect={() => onSelect(command.to)}>
			<span>{command.label}</span>
			{command.keys ? (
				<ShortcutKbd keys={command.keys} className="ml-auto" />
			) : null}
		</Item>
	);
}

function Item({
	value,
	onSelect,
	children,
}: {
	value: string;
	onSelect: () => void;
	children: React.ReactNode;
}) {
	return (
		<Command.Item
			value={value}
			onSelect={onSelect}
			className="flex cursor-pointer items-center gap-2 px-2 py-1.5 data-[selected=true]:bg-[var(--mfw-bg-hover)]"
			style={{ borderRadius: "var(--mfw-radius-sm)" }}
		>
			{children}
		</Command.Item>
	);
}
