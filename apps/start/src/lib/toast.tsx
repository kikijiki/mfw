import {
	CircleCheck,
	Info,
	OctagonAlert,
	TriangleAlert,
	X,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
} from "react";

/** Toasts for the "no silent failure" policy. Module-singleton store so non-React callers (MutationCache in lib/trpc.ts) can raise one. */

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastInput {
	tone?: ToastTone;
	title: string;
	description?: string;
	action?: ToastAction;
	/** ms; `0` means "stays until dismissed" (the default for errors). */
	duration?: number;
}

export interface Toast extends Required<Omit<ToastInput, "action">> {
	id: string;
	action?: ToastAction;
	createdAt: number;
}

/** Stack cap. */
const MAX_VISIBLE = 3;
const DEFAULT_DURATION: Record<ToastTone, number> = {
	info: 5_000,
	success: 3_000,
	warning: 8_000,
	error: 0,
};

class ToastBus {
	private toasts: Toast[] = [];
	private listeners = new Set<() => void>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private seq = 0;

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	};

	getSnapshot = (): Toast[] => this.toasts;

	/** Stable empty array: returning a fresh `[]` would loop the SSR snapshot. */
	getServerSnapshot = (): Toast[] => EMPTY;

	push = (input: ToastInput): string => {
		const tone = input.tone ?? "info";
		const toast: Toast = {
			id: `t${++this.seq}`,
			tone,
			title: input.title,
			description: input.description ?? "",
			duration: input.duration ?? DEFAULT_DURATION[tone],
			action: input.action,
			createdAt: Date.now(),
		};
		this.toasts = [...this.toasts, toast].slice(-MAX_VISIBLE);
		if (toast.duration > 0) {
			this.timers.set(
				toast.id,
				setTimeout(() => this.dismiss(toast.id), toast.duration),
			);
		}
		this.emit();
		return toast.id;
	};

	dismiss = (id: string): void => {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
		this.toasts = this.toasts.filter((t) => t.id !== id);
		this.emit();
	};

	clear = (): void => {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.toasts = EMPTY;
		this.emit();
	};

	private emit(): void {
		for (const fn of this.listeners) fn();
	}
}

const EMPTY: Toast[] = [];

export const toastBus = new ToastBus();

export interface ToastApi {
	toasts: Toast[];
	toast: (input: ToastInput) => string;
	dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
	const toasts = useSyncExternalStore(
		toastBus.subscribe,
		toastBus.getSnapshot,
		toastBus.getServerSnapshot,
	);
	const api = useMemo<ToastApi>(
		() => ({ toasts, toast: toastBus.push, dismiss: toastBus.dismiss }),
		[toasts],
	);
	return (
		<ToastContext.Provider value={api}>
			{children}
			<ToastViewport toasts={toasts} onDismiss={toastBus.dismiss} />
		</ToastContext.Provider>
	);
}

export function useToast(): ToastApi {
	const ctx = useContext(ToastContext);
	if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
	return ctx;
}

/**
 * `onError` for a mutation needing a specific verb ("Approve failed"). The
 * global handler in makeQueryClient still fires, so also pass
 * `meta: { toast: false }` to avoid two toasts.
 */
export function useMutationToast(label?: string) {
	const { toast } = useToast();
	return useCallback(
		(error: unknown) => {
			toast({
				tone: "error",
				title: label ? `${label} failed` : "Action failed",
				description: humanizeError(error),
				duration: 0,
			});
		},
		[toast, label],
	);
}

/** Turns a rejection into one readable line, surfacing tRPC `data.code` when the message is cryptic. */
export function humanizeError(error: unknown): string {
	if (error == null) return "Unknown error";
	if (typeof error === "string") return error;
	if (error instanceof Error) {
		const data = (error as { data?: { code?: string } }).data;
		const zod = (
			error as {
				data?: { zodError?: { formErrors?: string[] } | null };
			}
		).data?.zodError;
		const first = zod?.formErrors?.[0];
		if (first) return first;
		if (error.message.toLowerCase().includes("failed to fetch")) {
			return "Daemon unreachable: the request never left the browser.";
		}
		return data?.code && !error.message.includes(data.code)
			? `${error.message} (${data.code})`
			: error.message;
	}
	return String(error);
}

const TONE_ICON = {
	info: Info,
	success: CircleCheck,
	warning: TriangleAlert,
	error: OctagonAlert,
} as const;

const TONE_COLOR: Record<ToastTone, string> = {
	info: "var(--mfw-info)",
	success: "var(--mfw-ok)",
	warning: "var(--mfw-warn)",
	error: "var(--mfw-critical)",
};

function ToastViewport({
	toasts,
	onDismiss,
}: {
	toasts: Toast[];
	onDismiss: (id: string) => void;
}) {
	// Escape closes the newest toast, like any other overlay.
	useEffect(() => {
		if (toasts.length === 0) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const newest = toasts[toasts.length - 1];
			if (newest) onDismiss(newest.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toasts, onDismiss]);

	if (toasts.length === 0) return null;
	return (
		// Top on phone (tab bar is at the bottom), bottom-right on desktop.
		<output
			aria-live="polite"
			className="pointer-events-none fixed inset-x-2 top-2 z-100 flex flex-col gap-2 sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:w-90"
		>
			{toasts.map((t) => {
				const Icon = TONE_ICON[t.tone];
				return (
					<div
						key={t.id}
						className="mfw-v2 pointer-events-auto flex items-start gap-2 border p-3"
						style={{
							background: "var(--mfw-bg-raised)",
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-md)",
							boxShadow: "var(--mfw-shadow-overlay)",
						}}
					>
						<Icon
							aria-hidden
							className="mt-px size-4 shrink-0"
							style={{ color: TONE_COLOR[t.tone] }}
						/>
						<div className="min-w-0 flex-1">
							<div className="font-medium">{t.title}</div>
							{t.description ? (
								<div
									className="mt-0.5 break-words"
									style={{
										color: "var(--mfw-fg-muted)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									{t.description}
								</div>
							) : null}
							{t.action ? (
								<button
									type="button"
									className="mfw-focus mt-2 underline underline-offset-2"
									style={{ color: "var(--mfw-accent)" }}
									onClick={() => {
										t.action?.onClick();
										onDismiss(t.id);
									}}
								>
									{t.action.label}
								</button>
							) : null}
						</div>
						<button
							type="button"
							aria-label="Dismiss"
							className="mfw-focus shrink-0 p-0.5"
							style={{ color: "var(--mfw-fg-faint)" }}
							onClick={() => onDismiss(t.id)}
						>
							<X aria-hidden className="size-3.5" />
						</button>
					</div>
				);
			})}
		</output>
	);
}
