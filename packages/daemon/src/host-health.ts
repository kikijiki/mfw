/**
 * Host health that explains itself.
 *
 * The probe layer persists one row of health per adapter (`ok | degraded |
 * error | unsupported` plus its diagnostics). That is enough for admission but
 * not for a person asking "why does it say degraded?". This module turns that
 * row into a structured item: a stable `code`, the probe's own sentence, how
 * long it has been in this state, what mfw does about it and what to do.
 *
 * Two parts, both pure:
 *  - `HostHealthTracker` remembers since-when / last-ok / consecutive failures
 *    per kind. It lives in memory beside the one polling loop: probe state is
 *    per daemon process anyway (an older process's observation is stale).
 *  - `describeHostHealth` is the presentation mapping. It never feeds back
 *    into admission, which keeps reading the strict stored result.
 */

export type HostHealthStatus =
	| "ok"
	| "degraded"
	| "unavailable"
	| "unknown"
	| "disabled";

export interface HostHealthItem {
	kind: string;
	/** Short noun for the probe, e.g. "AMD GPU probe". */
	label: string;
	status: HostHealthStatus;
	/** Stable machine code: partial-observation, tool-missing, timeout, stale, unreachable ... */
	code: string | null;
	/** One readable status line: "AMD GPU probe: tool not installed". */
	summary: string;
	/** The probe's own sentence about the cause. */
	message: string | null;
	/** First time (epoch ms) it was seen in this state by this daemon. */
	since: number | null;
	lastOkAt: number | null;
	checkedAt: number | null;
	consecutiveFailures: number;
	/** What mfw does about it, in plain words. */
	affects: string | null;
	/** What to do. */
	hint: string | null;
	/**
	 * A first failure after a good reading: shown, but it does not turn the host
	 * amber until it repeats. Admission is unaffected (it stays strict).
	 */
	transient: boolean;
}

export interface HealthTrackEntry {
	/** The stored result this entry tracks ("ok", "degraded", "error", ...). */
	result: string;
	since: number;
	lastOkAt: number | null;
	consecutiveFailures: number;
}

/** A failure must repeat this many polls, or last this long, before it counts. */
export const TRANSIENT_FAILURES = 3;
export const TRANSIENT_MS = 3 * 60_000;
/** A probe row older than this is stale however it ended (the loop polls every few seconds). */
export const STALE_AFTER_MS = 2 * 60_000;

export class HostHealthTracker {
	private readonly entries = new Map<string, HealthTrackEntry>();

	record(kind: string, result: string, at: number): void {
		const prev = this.entries.get(kind);
		const ok = result === "ok";
		if (!prev) {
			this.entries.set(kind, {
				result,
				since: at,
				lastOkAt: ok ? at : null,
				consecutiveFailures: ok ? 0 : 1,
			});
			return;
		}
		this.entries.set(kind, {
			result,
			since: prev.result === result ? prev.since : at,
			lastOkAt: ok ? at : prev.lastOkAt,
			consecutiveFailures: ok ? 0 : prev.consecutiveFailures + 1,
		});
	}

	snapshot(): Record<string, HealthTrackEntry> {
		return Object.fromEntries(this.entries);
	}
}

// ---------------------------------------------------------------------------
// Presentation

const KIND_LABEL: Record<string, string> = {
	"linux-cpu": "CPU probe",
	"linux-memory": "Memory probe",
	"amd-gpu": "AMD GPU probe",
	"nvidia-gpu": "NVIDIA GPU probe",
	"linux-disk": "Disk probe",
};

export function healthKindLabel(kind: string): string {
	return KIND_LABEL[kind] ?? `${kind} probe`;
}

const CODE_PHRASE: Record<string, string> = {
	"partial-observation": "partial observation",
	"tool-missing": "tool not installed",
	"tool-version-unsupported": "tool version unsupported",
	"permission-denied": "permission denied",
	"probe-timeout": "timed out",
	timeout: "timed out",
	stale: "stale reading",
	unreachable: "unreachable",
	"execution-failed": "probe failed",
	"malformed-output": "unreadable output",
	"unsupported-platform": "not supported here",
	"output-truncated": "output too large",
	"output-too-large": "output too large",
};

export function codePhrase(code: string): string {
	return CODE_PHRASE[code] ?? code.replace(/-/g, " ");
}

/** Which diagnostic best names the cause when several are present. */
const CODE_PRIORITY = [
	"tool-missing",
	"permission-denied",
	"probe-timeout",
	"tool-version-unsupported",
	"unsupported-platform",
	"execution-failed",
	"malformed-output",
	"partial-observation",
];

function pickDiagnostic(
	diagnostics: ReadonlyArray<{ code: string; message: string }>,
): { code: string; message: string } | null {
	const rank = (code: string) => {
		const i = CODE_PRIORITY.indexOf(code);
		return i === -1 ? CODE_PRIORITY.length : i;
	};
	return (
		[...diagnostics].sort((a, b) => rank(a.code) - rank(b.code))[0] ?? null
	);
}

function isGpu(kind: string): boolean {
	return kind === "amd-gpu" || kind === "nvidia-gpu";
}

/** What mfw does while this probe is not healthy. Mirrors the strict admission gates. */
function affectsFor(kind: string): string {
	if (isGpu(kind))
		return "GPU slots are held while the device cannot be proven idle, so tasks that need a GPU wait. CPU and RAM-only work is not affected.";
	if (kind === "linux-memory")
		return "RAM-gated runs wait: with memory unreadable mfw cannot confirm headroom before starting one.";
	if (kind === "linux-cpu")
		return "CPU-gated runs wait until CPU pressure can be read again.";
	return "Resources gated on this probe are held until it reports again.";
}

function hintFor(kind: string, code: string): string {
	switch (code) {
		case "tool-missing":
			if (kind === "amd-gpu")
				return "Install amd-smi (ROCm) so idle GPUs can be proven, or mark the GPU resource 'ignore observation' if mfw owns the GPU. Re-check afterwards.";
			if (kind === "nvidia-gpu")
				return "Install the NVIDIA driver tools (nvidia-smi), then re-check.";
			return "Install the missing tool on this machine, then re-check.";
		case "permission-denied":
			return "Give the user running mfw read access (for GPUs: the video/render groups and /dev/kfd), then re-check.";
		case "probe-timeout":
		case "timeout":
			return "The tool is answering slowly; mfw retries on its own. If it persists, check machine load.";
		case "stale":
			return "The probe loop has not reported recently. Re-check now; if it stays stale, restart the daemon.";
		case "unreachable":
			return "Check the host is up and reachable over SSH, then re-check.";
		case "partial-observation":
			return "Usually clears by itself once the device or its processes stop changing; mfw retries every few seconds.";
		default:
			return "Re-check now. If it persists, the daemon log has the probe's full diagnostics.";
	}
}

export interface StoredHealthLike {
	kind: string;
	result: string;
	checkedAt: number;
	detail?: Record<string, unknown>;
}

function diagnosticsOf(
	detail: Record<string, unknown> | undefined,
): Array<{ code: string; message: string }> {
	const raw = detail?.diagnostics;
	if (!Array.isArray(raw)) return [];
	const out: Array<{ code: string; message: string }> = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.code === "string")
			out.push({
				code: rec.code,
				message: typeof rec.message === "string" ? rec.message : "",
			});
	}
	return out;
}

export function describeHostHealth(
	stored: StoredHealthLike,
	track: HealthTrackEntry | undefined,
	now: number,
): HostHealthItem {
	const label = healthKindLabel(stored.kind);
	const base = {
		kind: stored.kind,
		label,
		since: track?.since ?? null,
		lastOkAt: track?.lastOkAt ?? null,
		checkedAt: stored.checkedAt,
		consecutiveFailures: track?.consecutiveFailures ?? 0,
	};
	const freshness = stored.detail?.freshness;
	const staleByState =
		freshness !== null &&
		typeof freshness === "object" &&
		(freshness as Record<string, unknown>).state === "stale";
	const aged = now - stored.checkedAt > STALE_AFTER_MS;
	if (stored.result === "ok" && !aged && !staleByState) {
		return {
			...base,
			status: "ok",
			code: null,
			summary: `${label}: ok`,
			message: null,
			affects: null,
			hint: null,
			transient: false,
		};
	}
	if (stored.result === "unsupported") {
		const diag = pickDiagnostic(diagnosticsOf(stored.detail));
		return {
			...base,
			status: "disabled",
			code: diag?.code ?? "unsupported-platform",
			summary: `${label}: not available on this machine`,
			message: diag?.message || "This probe is not supported here.",
			affects: "No effect: resources that need this probe are not offered.",
			hint: null,
			transient: false,
		};
	}
	const stale = stored.result === "ok";
	const diag = stale ? null : pickDiagnostic(diagnosticsOf(stored.detail));
	const code = stale
		? "stale"
		: (diag?.code ??
			(stored.result === "degraded"
				? "partial-observation"
				: "execution-failed"));
	const message = stale
		? `The last reading is ${Math.round((now - stored.checkedAt) / 1000)}s old; the probe has not reported since.`
		: diag?.message ||
			(stored.result === "degraded"
				? "The probe returned a partial reading."
				: "The probe could not produce a reading.");
	const failures = base.consecutiveFailures;
	const transient =
		stored.result === "error" &&
		failures < TRANSIENT_FAILURES &&
		(base.since === null || now - base.since < TRANSIENT_MS);
	return {
		...base,
		status: "degraded",
		code,
		summary: `${label}: ${codePhrase(code)}`,
		message,
		affects: affectsFor(stored.kind),
		hint: hintFor(stored.kind, code),
		transient,
	};
}

/** The worst status of a set of items; transient and disabled items do not count. */
export function overallHealth(
	items: readonly HostHealthItem[],
): HostHealthStatus {
	if (items.length === 0) return "unknown";
	const counted = items.filter((i) => !i.transient && i.status !== "disabled");
	if (counted.some((i) => i.status === "unavailable")) return "unavailable";
	if (counted.some((i) => i.status === "degraded")) return "degraded";
	if (counted.some((i) => i.status === "unknown")) return "unknown";
	if (counted.length === 0 && items.every((i) => i.status === "disabled"))
		return "disabled";
	return "ok";
}
