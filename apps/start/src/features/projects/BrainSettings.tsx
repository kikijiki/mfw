import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import {
	BRAIN_DEFAULT_HINTS,
	type BrainDraft,
	brainPatch,
	describeBrain,
	draftFromStored,
	draftProblems,
	EFFORTS,
	isDirty,
	moveRoute,
	type RouteDraft,
} from "./brainDraft";

const selectClass =
	"mfw-focus h-8 rounded-md border bg-transparent px-2 text-sm";
const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;

/**
 * Project settings, "Brain": the ordered routes the project brain may run on,
 * its heartbeat, rollover and turn caps. It is off until a route is set; this
 * is the switch. The brain applies the new config on its next tick (no
 * restart), and while it runs in shadow mode the fixed pipeline still decides
 * and acts.
 */
export function BrainSettings({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const settings = useQuery(trpc.settings.get.queryOptions({ project }));
	const catalogue = useQuery(trpc.settings.providers.catalogue.queryOptions());
	const stored = settings.data?.values.brain ?? null;

	const base = useMemo(() => draftFromStored(stored), [stored]);
	const [draft, setDraft] = useState<BrainDraft | null>(null);
	// Adopt the server's copy while clean, so a refetch never eats an edit.
	useEffect(() => {
		if (!settings.data) return;
		setDraft((cur) => (cur === null || !isDirty(cur, base) ? base : cur));
	}, [settings.data, base]);

	const save = useMutation(
		trpc.settings.update.mutationOptions({
			meta: { label: "Save brain settings" },
			onSuccess: (view) => {
				setDraft(draftFromStored(view.values.brain));
				toast({ tone: "success", title: `${project} brain settings saved` });
			},
			onSettled: () => {
				void queryClient.invalidateQueries(
					trpc.settings.get.queryFilter({ project }),
				);
				void queryClient.invalidateQueries(trpc.brain.states.queryFilter());
				void queryClient.invalidateQueries(
					trpc.brain.session.queryFilter({ project }),
				);
			},
		}),
	);

	if (settings.isError) {
		return (
			<Panel title="Brain">
				<ErrorState
					title="Could not read the brain settings"
					error={settings.error}
					onRetry={() => void settings.refetch()}
				/>
			</Panel>
		);
	}
	if (!settings.data || !draft) {
		return (
			<Panel title="Brain">
				<LoadingRows rows={3} />
			</Panel>
		);
	}

	const problems = draftProblems(draft);
	const dirty = isDirty(draft, base);
	const providers = (catalogue.data?.providers ?? []).filter((p) =>
		catalogue.data?.selectableProviderIds.includes(p.id),
	);
	const providerIds = new Set(providers.map((p) => p.id));
	const set = (patch: Partial<BrainDraft>) =>
		setDraft((d) => (d ? { ...d, ...patch } : d));
	const setRoute = (i: number, patch: Partial<RouteDraft>) =>
		set({
			routes: draft.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)),
		});
	const addRoute = () =>
		set({
			routes: [
				...draft.routes,
				{
					provider: providers[0]?.id ?? "claude-cli",
					model: providers[0]?.defaultModel ?? "",
					effort: "",
				},
			],
		});

	return (
		<Panel
			title="Brain"
			actions={
				<Chip tone={stored ? "accent" : "neutral"}>
					{stored ? "on" : "off"}
				</Chip>
			}
		>
			<div className="flex flex-col gap-3" data-testid="brain-settings">
				<p className="m-0" style={{ ...muted, ...small }}>
					{describeBrain(stored)} The brain decides what runs, on which harness
					and model, how failures are handled and what happens next, and records
					every decision with its rationale. Without a route nothing is
					dispatched.
				</p>

				<fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
					<legend style={{ ...muted, ...small }}>
						Routes, tried in order (the next is used when the first is held)
					</legend>
					{draft.routes.length === 0 ? (
						<p className="m-0" style={{ ...muted, ...small }}>
							No routes: the brain is off. Add one to turn it on.
						</p>
					) : null}
					{draft.routes.map((r, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: an ordered, editable list; order is the identity
						<div key={i} className="flex flex-wrap items-center gap-2">
							<span className="mfw-num w-5" style={muted}>
								{i + 1}
							</span>
							<select
								aria-label={`Route ${i + 1} provider`}
								className={selectClass}
								style={{ borderColor: "var(--mfw-border)" }}
								value={r.provider}
								onChange={(e) => setRoute(i, { provider: e.target.value })}
							>
								{providerIds.has(r.provider) || r.provider === "" ? null : (
									<option value={r.provider}>{r.provider}</option>
								)}
								{providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
							<Input
								aria-label={`Route ${i + 1} model`}
								className="h-8 w-48"
								placeholder="provider default"
								value={r.model}
								onChange={(e) => setRoute(i, { model: e.target.value })}
							/>
							<select
								aria-label={`Route ${i + 1} effort`}
								className={selectClass}
								style={{ borderColor: "var(--mfw-border)" }}
								value={r.effort}
								onChange={(e) =>
									setRoute(i, {
										effort: e.target.value as RouteDraft["effort"],
									})
								}
							>
								<option value="">default effort</option>
								{EFFORTS.map((e) => (
									<option key={e} value={e}>
										{e}
									</option>
								))}
							</select>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label={`Move route ${i + 1} up`}
								disabled={i === 0}
								onClick={() => set({ routes: moveRoute(draft.routes, i, -1) })}
							>
								<ArrowUp aria-hidden />
							</Button>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label={`Move route ${i + 1} down`}
								disabled={i === draft.routes.length - 1}
								onClick={() => set({ routes: moveRoute(draft.routes, i, 1) })}
							>
								<ArrowDown aria-hidden />
							</Button>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label={`Remove route ${i + 1}`}
								onClick={() =>
									set({ routes: draft.routes.filter((_, j) => j !== i) })
								}
							>
								<Trash2 aria-hidden />
							</Button>
						</div>
					))}
					<div>
						<Button size="xs" variant="outline" onClick={addRoute}>
							<Plus aria-hidden /> Add route
						</Button>
					</div>
				</fieldset>

				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<NumberField
						label="Heartbeat (minutes)"
						value={draft.heartbeatMin}
						placeholder={BRAIN_DEFAULT_HINTS.heartbeatMin}
						onChange={(v) => set({ heartbeatMin: v })}
					/>
					<NumberField
						label="Rollover tokens"
						value={draft.rolloverTokens}
						placeholder={BRAIN_DEFAULT_HINTS.rolloverTokens}
						onChange={(v) => set({ rolloverTokens: v })}
					/>
					<NumberField
						label="Turn timeout (minutes)"
						value={draft.turnTimeoutMin}
						placeholder={BRAIN_DEFAULT_HINTS.turnTimeoutMin}
						onChange={(v) => set({ turnTimeoutMin: v })}
					/>
					<NumberField
						label="Max turns per hour"
						value={draft.maxTurnsPerHour}
						placeholder={BRAIN_DEFAULT_HINTS.maxTurnsPerHour}
						onChange={(v) => set({ maxTurnsPerHour: v })}
					/>
					<NumberField
						label="Max turns per day"
						value={draft.maxTurnsPerDay}
						placeholder={BRAIN_DEFAULT_HINTS.maxTurnsPerDay}
						onChange={(v) => set({ maxTurnsPerDay: v })}
					/>
				</div>

				{problems.length > 0 ? (
					<ul
						role="alert"
						className="m-0 pl-4"
						style={{ color: "var(--mfw-critical)", ...small }}
					>
						{problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				) : null}

				<div className="flex items-center gap-2">
					<Button
						size="sm"
						disabled={!dirty || problems.length > 0 || save.isPending}
						onClick={() =>
							save.mutate({ project, patch: { brain: brainPatch(draft) } })
						}
					>
						{draft.routes.length === 0 && stored
							? "Turn the brain off"
							: stored
								? "Save brain settings"
								: "Turn the brain on"}
					</Button>
					{dirty ? (
						<Button size="sm" variant="ghost" onClick={() => setDraft(base)}>
							Discard
						</Button>
					) : null}
				</div>
			</div>
		</Panel>
	);
}

function NumberField({
	label,
	value,
	placeholder,
	onChange,
}: {
	label: string;
	value: string;
	placeholder: number;
	onChange: (v: string) => void;
}) {
	return (
		<div className="flex flex-col gap-0.5" style={small}>
			<span style={muted}>{label}</span>
			<Input
				inputMode="numeric"
				className="h-8"
				aria-label={label}
				placeholder={`${placeholder} (default)`}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}
