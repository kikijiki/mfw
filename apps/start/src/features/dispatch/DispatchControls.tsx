import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleHelp, Play, Square } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Tip } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Chip } from "../../components/Page";
import { formatAbsolute } from "../../lib/format";
import { useLive } from "../../lib/live";
import { humanizeError, useToast } from "../../lib/toast";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	canStartFleet,
	type DispatchStatusLike,
	dispatchAction,
	dispatchExplain,
	dispatchLabel,
	dispatchTone,
	type FleetLike,
	fleetFailures,
	fleetLabel,
	fleetTone,
	globalAction,
	NO_BRAIN_HINT,
} from "./state";

/**
 * Dispatch controls. One control per project: play clears the persisted pause,
 * starts the loop and writes `schedulerAutostart`; stop is the inverse.
 *
 * Starting is confirmed (it spends a subscription), stopping is one click.
 * Engine-imposed stops (hold, red main) leave the project playing; the chip
 * says who stopped it and the control still offers "stop".
 */

/**
 * One project's dispatch switch: the status query, the play/stop mutation and
 * the confirm-before-start dialog state. Any surface (the project header, the
 * sidebar tile menu) renders its own control from this and mounts
 * `ProjectDispatchDialog` once, so a confirmation survives its menu closing.
 */
export function useProjectDispatch(project: string) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [confirmPlay, setConfirmPlay] = useState(false);

	const status = useQuery(
		trpc.system.scheduler.status.queryOptions({ project }),
	);

	const set = useMutation(
		trpc.system.scheduler.set.mutationOptions({
			// Own toast: reports the state the server returned, not just success.
			meta: { toast: false },
			onSuccess: (next) => {
				setConfirmPlay(false);
				if (!next.projectPlaying) {
					toast({ tone: "success", title: `${project} stopped dispatching` });
				} else if (!next.globalPlaying) {
					// Project switch is on but the master stop is off.
					toast({
						tone: "warning",
						title: `${project} is switched on, but mfw is stopped`,
						description: dispatchExplain(next),
						duration: 0,
					});
				} else if (next.selfStopped) {
					// Play succeeded but nothing will start.
					toast({
						tone: "warning",
						title: `${project} is playing, but not dispatching`,
						description: dispatchExplain(next),
						duration: 0,
					});
				} else {
					toast({ tone: "success", title: `${project} is dispatching` });
				}
			},
			onError: (error) => {
				toast({
					tone: "error",
					title: `Could not change dispatch for ${project}`,
					description: humanizeError(error),
					duration: 0,
				});
			},
			onSettled: () => invalidateDispatch(queryClient, trpc, project),
		}),
	);

	const data = status.data ?? null;
	// Reads `projectPlaying`, not effective `playing`: with the master stop off,
	// a switched-on project must still offer Stop.
	const playing = data ? dispatchAction(data) === "stop" : false;
	const label = data
		? `${playing ? "Stop" : "Start"} dispatching in ${project}: ${dispatchExplain(data)}`
		: `Dispatch control for ${project}`;

	return {
		project,
		data,
		playing,
		pending: set.isPending,
		label,
		confirmPlay,
		setConfirmPlay,
		/** Stop is one click; start asks first (it spends a subscription). */
		toggle: () => {
			if (playing) set.mutate({ project, enabled: false });
			else setConfirmPlay(true);
		},
		confirm: () => set.mutate({ project, enabled: true }),
	};
}

export type ProjectDispatch = ReturnType<typeof useProjectDispatch>;

/** The start confirmation for a `useProjectDispatch`. Mount it once per project. */
export function ProjectDispatchDialog({
	dispatch,
}: {
	dispatch: ProjectDispatch;
}) {
	const { project } = dispatch;
	return (
		<ConfirmDialog
			open={dispatch.confirmPlay}
			onOpenChange={dispatch.setConfirmPlay}
			title={`Start dispatching in ${project}?`}
			description={
				<>
					MFW will start ready tasks in <strong>{project}</strong>. This may use
					your provider credits and stays enabled until you stop it.
				</>
			}
			confirmLabel="Start dispatching"
			pending={dispatch.pending}
			onConfirm={dispatch.confirm}
		/>
	);
}

export function ProjectDispatchButton({
	project,
	/** `icon` is the sidebar/mobile form: no text, everything in the label. */
	variant = "full",
	className,
}: {
	project: string;
	variant?: "full" | "icon";
	className?: string;
}) {
	const dispatch = useProjectDispatch(project);
	const { data, playing, pending, label } = dispatch;
	const icon = playing ? <Square aria-hidden /> : <Play aria-hidden />;
	const onClick = dispatch.toggle;

	return (
		<>
			{variant === "icon" ? (
				<Tip label={label}>
					<Button
						// 28px: sits in a 36px sidebar row and, on a phone, is the only way to stop the project.
						size="icon-sm"
						variant="ghost"
						className={cn("max-md:size-11", className)}
						aria-label={label}
						aria-pressed={playing}
						disabled={pending || !data}
						onClick={onClick}
						style={{ color: `var(--mfw-${playing ? "ok" : "fg-faint"})` }}
					>
						{icon}
					</Button>
				</Tip>
			) : (
				<span className={cn("inline-flex items-center gap-1.5", className)}>
					<Tip label={label}>
						<Button
							size="sm"
							variant="outline"
							className="max-md:min-h-11 max-md:px-3"
							aria-label={label}
							aria-pressed={playing}
							disabled={pending || !data}
							onClick={onClick}
						>
							{icon}
							{pending ? "Working…" : playing ? "Stop" : "Play"}
						</Button>
					</Tip>
					{data ? <DispatchChip status={data} project={project} /> : null}
				</span>
			)}
			<ProjectDispatchDialog dispatch={dispatch} />
		</>
	);
}

/** The status pill: state, who caused it, and when a hold lifts. */
export function DispatchChip({
	status,
	project,
}: {
	status: DispatchStatusLike;
	/** With a project, a blocked-by-no-brain chip links to its settings. */
	project?: string;
}) {
	const detail = status.hold
		? `${dispatchExplain(status)} (until ${formatAbsolute(status.hold.until)})`
		: dispatchExplain(status);
	const chip = (
		<Tip label={detail}>
			<span className="inline-flex">
				<Chip tone={dispatchTone(status)}>{dispatchLabel(status)}</Chip>
			</span>
		</Tip>
	);
	if (status.blocked === "no_brain_route" && project) {
		return (
			<AppLink
				to={href.projectSettings(project)}
				aria-label={`${NO_BRAIN_HINT}: open ${project} settings`}
			>
				{chip}
			</AppLink>
		);
	}
	return chip;
}

/**
 * The machine-wide master stop: one boolean, ANDed with each project's own
 * switch so neither overwrites the other. The chip shows whether mfw is running
 * and how many projects are armed underneath it.
 */
export function GlobalDispatchButton({
	variant = "full",
	compact = false,
	className,
}: {
	variant?: "full" | "icon" | "navigation" | "status";
	/** Hides navigation-row copy while retaining its accessible name. For `status`, the single-control rail form. */
	compact?: boolean;
	className?: string;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const [confirmPlay, setConfirmPlay] = useState(false);

	const fleet = useQuery(trpc.system.scheduler.all.queryOptions());
	const { status: connection } = useLive();

	const setGlobal = useMutation(
		trpc.system.scheduler.setGlobal.mutationOptions({
			meta: { toast: false },
			onSuccess: (next) => {
				setConfirmPlay(false);
				toast({ tone: "success", title: fleetLabel(next) });
			},
			onError: (error) => {
				toast({
					tone: "error",
					title: "Could not change dispatch",
					description: humanizeError(error),
					duration: 0,
				});
			},
			onSettled: () => invalidateDispatch(queryClient, trpc),
		}),
	);

	const data: FleetLike | null = fleet.data ?? null;
	const action = data ? globalAction(data) : null;
	const playing = action === "stop";
	const summary = data
		? fleetLabel(data)
		: fleet.isPending
			? "Checking mfw…"
			: "mfw status unavailable";
	const pending = setGlobal.isPending;
	const failures = data ? fleetFailures(data) : [];
	const failureText =
		failures.length > 0
			? `Cannot verify ${failures.join(", ")}. Start is blocked until ${failures.length === 1 ? "it reports" : "they report"} current status.`
			: fleet.error
				? "MFW dispatch status could not be read."
				: null;
	const startBlocked =
		data !== null &&
		action === "play" &&
		(fleet.error !== null || !canStartFleet(data));
	const unavailable = data === null;
	const statusIcon = unavailable ? (
		fleet.error ? (
			<CircleAlert aria-hidden />
		) : (
			<CircleHelp aria-hidden />
		)
	) : failureText ? (
		<CircleAlert aria-hidden />
	) : playing ? (
		<Square aria-hidden />
	) : (
		<Play aria-hidden />
	);
	const label = failureText
		? `${playing ? "Stop mfw everywhere" : "Start mfw unavailable"}: ${failureText}`
		: action === "play"
			? `Start mfw: ${summary}`
			: action === "stop"
				? `Stop mfw everywhere: ${summary}`
				: summary;
	const actionLabel = unavailable
		? summary
		: playing
			? "Stop mfw"
			: startBlocked
				? "Start unavailable"
				: "Start mfw";
	// Only projects switched on will begin; lifting the master stop does not start the rest.
	const willStart = (data?.projects ?? []).filter(
		(p) => p.status?.projectPlaying === true,
	);

	return (
		<div
			className={cn(
				variant === "navigation"
					? "flex w-full flex-col items-start"
					: variant === "status"
						? "flex w-full items-center"
						: "flex items-center gap-0.5",
				className,
			)}
		>
			{variant === "full" ? (
				<Chip tone={data ? fleetTone(data) : "warn"} className="mr-1">
					{summary}
				</Chip>
			) : null}
			{variant === "status" ? (
				<MfwStatusGroup
					compact={compact}
					connection={connection}
					dispatchWord={
						unavailable ? "unknown" : playing ? "running" : "paused"
					}
					failed={failureText !== null}
					detail={label}
					statusIcon={statusIcon}
					disabled={pending || unavailable || startBlocked}
					playing={playing}
					onToggle={() =>
						playing
							? setGlobal.mutate({ enabled: false })
							: action === "play"
								? setConfirmPlay(true)
								: undefined
					}
				/>
			) : variant === "navigation" ? (
				<Button
					type="button"
					variant="ghost"
					aria-label={label}
					aria-pressed={unavailable ? undefined : playing}
					disabled={pending || unavailable || startBlocked}
					className={cn(
						"mfw-focus h-[var(--mfw-row-h)] w-full gap-2 rounded-[var(--mfw-radius-md)] px-2 font-normal",
						compact ? "justify-center px-0" : "justify-start",
					)}
					style={{
						color:
							unavailable || failureText
								? "var(--mfw-warn)"
								: "var(--mfw-fg-muted)",
					}}
					onClick={() =>
						playing
							? setGlobal.mutate({ enabled: false })
							: action === "play"
								? setConfirmPlay(true)
								: undefined
					}
				>
					<span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
						{statusIcon}
					</span>
					{compact ? null : (
						<span className="min-w-0 flex-1 truncate text-left">
							{pending ? "Working…" : actionLabel}
						</span>
					)}
				</Button>
			) : variant === "icon" ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={label}
					aria-pressed={unavailable ? undefined : playing}
					disabled={pending || unavailable || startBlocked}
					className="max-md:size-11"
					style={
						unavailable || failureText
							? { color: "var(--mfw-warn)" }
							: undefined
					}
					onClick={() =>
						playing
							? setGlobal.mutate({ enabled: false })
							: action === "play"
								? setConfirmPlay(true)
								: undefined
					}
				>
					{statusIcon}
				</Button>
			) : (
				<Switch
					aria-label={label}
					checked={playing}
					disabled={pending || unavailable || startBlocked}
					onCheckedChange={(checked) =>
						checked
							? setConfirmPlay(true)
							: setGlobal.mutate({ enabled: false })
					}
				/>
			)}
			{failureText && variant === "navigation" && !compact ? (
				<p
					role="status"
					className="px-2 pb-1.5 leading-tight"
					style={{
						color: "var(--mfw-warn)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{failureText}
				</p>
			) : null}

			<ConfirmDialog
				open={confirmPlay}
				onOpenChange={setConfirmPlay}
				title={
					willStart.length === 0
						? "Start mfw?"
						: `Start mfw: ${willStart.length} project${willStart.length === 1 ? "" : "s"} will begin dispatching?`
				}
				description={
					willStart.length === 0 ? (
						<>
							mfw starts dispatching again. No project is switched on right now,
							so nothing begins until you play one. This only lifts the
							machine-wide stop. It stays lifted across restarts.
						</>
					) : (
						<>
							These projects are switched on and start picking up ready tasks
							immediately, which spends your subscription. Projects that are
							individually stopped stay stopped. It stays on across restarts
							until you stop it.
						</>
					)
				}
				confirmLabel="Start mfw"
				pending={pending}
				onConfirm={() => {
					if (!data || fleet.error || !canStartFleet(data)) return;
					setGlobal.mutate({ enabled: true });
				}}
			>
				<ul
					className="flex flex-col gap-0.5"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{willStart.map((p) => (
						<li key={p.project}>{p.project}</li>
					))}
				</ul>
			</ConfirmDialog>
		</div>
	);
}

const DOT: Record<string, string> = {
	running: "--mfw-ok",
	paused: "--mfw-fg-faint",
	unknown: "--mfw-warn",
	reconnecting: "--mfw-warn",
	unreachable: "--mfw-critical",
};

/**
 * The mfw identity's status and its master switch as ONE group: a dot, a word
 * (running, paused, reconnecting, unreachable) and the play/stop button. The
 * dot is the daemon connection first (no connection, no truth about
 * dispatch), then the master stop. Collapsed it is a single small control.
 */
function MfwStatusGroup({
	compact,
	connection,
	dispatchWord,
	failed,
	detail,
	statusIcon,
	disabled,
	playing,
	onToggle,
}: {
	compact: boolean;
	connection: "connected" | "reconnecting" | "offline";
	dispatchWord: "running" | "paused" | "unknown";
	failed: boolean;
	detail: string;
	statusIcon: ReactNode;
	disabled: boolean;
	playing: boolean;
	onToggle: () => void;
}) {
	const word =
		connection === "offline"
			? "unreachable"
			: connection === "reconnecting"
				? "reconnecting"
				: dispatchWord;
	const token = failed && word === "running" ? "--mfw-warn" : DOT[word];
	const connectionNote =
		connection === "offline"
			? "The daemon is not reachable."
			: connection === "reconnecting"
				? "Reconnecting to the daemon."
				: "Connected to the daemon.";
	const tip = `mfw ${word}. ${connectionNote} ${detail}`;
	const dot = (
		<span
			aria-hidden
			className={cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				connection !== "connected" && "mfw-pulse",
			)}
			style={{ background: `var(${token})` }}
		/>
	);
	if (compact) {
		return (
			<Tip label={tip} side="right">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="relative self-center"
					aria-label={`mfw ${word}: ${detail}`}
					aria-pressed={playing}
					disabled={disabled}
					onClick={onToggle}
					style={{ color: `var(${token})` }}
				>
					{statusIcon}
					<span
						aria-hidden
						className="absolute top-0.5 right-0.5 size-1.5 rounded-full"
						style={{ background: `var(${token})` }}
					/>
				</Button>
			</Tip>
		);
	}
	return (
		<fieldset
			aria-label="mfw status"
			className="m-0 flex w-full min-w-0 items-center gap-2 border-0 px-2 py-0"
			style={{ minHeight: "var(--mfw-row-h)" }}
		>
			<Tip label={tip} side="right">
				<span
					role="status"
					className="flex min-w-0 flex-1 items-center gap-2"
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{dot}
					<span className="truncate">{word}</span>
				</span>
			</Tip>
			<Tip label={tip} side="right">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`${playing ? "Stop" : "Start"} mfw: ${detail}`}
					aria-pressed={playing}
					disabled={disabled}
					onClick={onToggle}
					style={{ color: `var(${token})` }}
				>
					{statusIcon}
				</Button>
			</Tip>
		</fieldset>
	);
}

/** Invalidate every query a dispatch change is visible through, including `settings.get` (play/stop writes `schedulerAutostart`). */
function invalidateDispatch(
	queryClient: ReturnType<typeof useQueryClient>,
	trpc: ReturnType<typeof useTRPC>,
	project?: string,
): void {
	void queryClient.invalidateQueries(trpc.system.scheduler.all.queryFilter());
	void queryClient.invalidateQueries(trpc.system.health.queryFilter());
	if (project) {
		void queryClient.invalidateQueries(
			trpc.system.scheduler.status.queryFilter({ project }),
		);
		void queryClient.invalidateQueries(
			trpc.settings.get.queryFilter({ project }),
		);
		return;
	}
	void queryClient.invalidateQueries(
		trpc.system.scheduler.status.queryFilter(),
	);
	void queryClient.invalidateQueries(trpc.settings.get.queryFilter());
}
