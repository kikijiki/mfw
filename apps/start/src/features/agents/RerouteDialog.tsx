import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

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
import { Label } from "~/components/ui/label";
import { useTRPC } from "../../lib/trpc";
import {
	buildPick,
	type CurrentRoute,
	EFFORTS,
	harnessChoices,
	hostChoices,
	initialForm,
	type RouteForm,
	type RoutePick,
} from "./routePick";

/**
 * Pick another harness, model, effort or host from the routing catalogue
 * (`settings.providers.catalogue`, `hosts.list`). Two uses, one form:
 * Reroute (stop a run, keep its worktree, continue it there) and Add attempt
 * (one more competing attempt in a group). The server's refusal, with its
 * fix, is shown in the dialog and the dialog stays open.
 */

const selectClass =
	"mfw-focus h-8 w-full border bg-transparent px-2 text-[length:var(--mfw-text-sm)]";

function RoutePickDialog({
	open,
	onOpenChange,
	title,
	description,
	submitLabel,
	current,
	requireChange,
	pending,
	error,
	onSubmit,
	extra,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	submitLabel: string;
	current: CurrentRoute;
	requireChange: boolean;
	pending: boolean;
	error: string | null;
	onSubmit: (pick: RoutePick) => void;
	extra?: ReactNode;
}) {
	const trpc = useTRPC();
	const catalogue = useQuery({
		...trpc.settings.providers.catalogue.queryOptions(),
		enabled: open,
	});
	const hosts = useQuery({ ...trpc.hosts.list.queryOptions(), enabled: open });
	const harnesses = useMemo(
		() => harnessChoices(catalogue.data?.providers),
		[catalogue.data],
	);
	const hostOptions = useMemo(() => hostChoices(hosts.data), [hosts.data]);
	const [form, setForm] = useState<RouteForm>(() => initialForm(current));
	const [localError, setLocalError] = useState<string | null>(null);
	const id = useId();

	// A reopened dialog starts from the run's own route again.
	const { harness: curHarness, model: curModel, hostId: curHost } = current;
	useEffect(() => {
		if (open) {
			setForm(
				initialForm({ harness: curHarness, model: curModel, hostId: curHost }),
			);
			setLocalError(null);
		}
	}, [open, curHarness, curModel, curHost]);

	const models = harnesses.find((h) => h.id === form.harness)?.models ?? [];
	const set = (patch: Partial<RouteForm>) =>
		setForm((f) => ({ ...f, ...patch }));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						const built = buildPick(form, current, { requireChange });
						if (!built.ok) {
							setLocalError(built.reason);
							return;
						}
						setLocalError(null);
						onSubmit(built.pick);
					}}
				>
					<div className="flex flex-col gap-1">
						<Label htmlFor={`${id}-harness`}>Harness</Label>
						<select
							id={`${id}-harness`}
							className={selectClass}
							style={{ borderColor: "var(--mfw-border)" }}
							value={form.harness}
							onChange={(e) => {
								const h = harnesses.find((x) => x.id === e.target.value);
								set({
									harness: e.target.value,
									// A different harness has different models: start from its default.
									model:
										e.target.value === (current.harness ?? "")
											? (current.model ?? "")
											: (h?.defaultModel ?? ""),
								});
							}}
						>
							<option value="">Keep the current one</option>
							{harnesses.map((h) => (
								<option key={h.id} value={h.id}>
									{h.name}
									{h.id === current.harness ? " (current)" : ""}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor={`${id}-model`}>Model</Label>
						<Input
							id={`${id}-model`}
							list={`${id}-models`}
							value={form.model}
							placeholder={current.model ?? "model"}
							onChange={(e) => set({ model: e.target.value })}
						/>
						<datalist id={`${id}-models`}>
							{models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</datalist>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor={`${id}-effort`}>Effort</Label>
							<select
								id={`${id}-effort`}
								className={selectClass}
								style={{ borderColor: "var(--mfw-border)" }}
								value={form.effort}
								onChange={(e) => set({ effort: e.target.value })}
							>
								<option value="">Default</option>
								{EFFORTS.map((x) => (
									<option key={x} value={x}>
										{x}
									</option>
								))}
							</select>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor={`${id}-host`}>Host</Label>
							<select
								id={`${id}-host`}
								className={selectClass}
								style={{ borderColor: "var(--mfw-border)" }}
								value={form.target}
								onChange={(e) => set({ target: e.target.value })}
							>
								{hostOptions.map((h) => (
									<option key={h.value} value={h.value}>
										{h.label}
									</option>
								))}
							</select>
						</div>
					</div>
					{extra}
					{localError || error ? (
						<p
							role="alert"
							style={{
								color: "var(--mfw-warn)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{localError ?? error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={pending}>
							{pending ? "Working…" : submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Reroute: stop the run (worktree kept) and continue it on the picked route. */
export function RerouteDialog({
	open,
	onOpenChange,
	label,
	current,
	live,
	pending,
	error,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	label: string;
	current: CurrentRoute;
	/** The run is still running: it is stopped first. */
	live: boolean;
	pending: boolean;
	error: string | null;
	onSubmit: (pick: RoutePick) => void;
}) {
	return (
		<RoutePickDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Reroute ${label}`}
			description={
				live
					? "The run is stopped with its worktree kept, then continued there on the route you pick. The brain is told."
					: "A new run continues in this run's worktree on the route you pick. The brain is told."
			}
			submitLabel={live ? "Stop and reroute" : "Reroute"}
			current={current}
			requireChange
			pending={pending}
			error={error}
			onSubmit={onSubmit}
		/>
	);
}

/** Add attempt: one more competing attempt in an open group. */
export function AddAttemptDialog({
	open,
	onOpenChange,
	current,
	pending,
	error,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: CurrentRoute;
	pending: boolean;
	error: string | null;
	onSubmit: (pick: RoutePick) => void;
}) {
	return (
		<RoutePickDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Add attempt"
			description="Another competing attempt starts in its own worktree. The group's attempt cap and the task's live-run cap apply."
			submitLabel="Add attempt"
			current={current}
			requireChange={false}
			pending={pending}
			error={error}
			onSubmit={onSubmit}
		/>
	);
}
