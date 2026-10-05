import type {
	ByteCount,
	GpuDeviceIdentity,
	GpuDeviceObservation,
	GpuOccupancyEvidence,
	GpuOccupant,
	LinuxCpuDiscovery,
	LinuxCpuPressure,
	LinuxMemoryObservation,
	PidStartEvidence,
	ProbeCapture,
	ProbeDiagnostic,
	ProbeDiagnosticCode,
	ProbeResult,
} from "@mfw/core/host-observation";

export const HOST_PROBE_PARSE_LIMITS = {
	maxInputBytes: 1024 * 1024,
	maxLines: 16_384,
	maxLineBytes: 16 * 1024,
	maxRecords: 4096,
} as const;

export interface ProcStatSnapshot {
	logicalProcessors: number;
	cpu: {
		user: bigint;
		nice: bigint;
		system: bigint;
		idle: bigint;
		iowait: bigint;
		irq: bigint;
		softirq: bigint;
		steal: bigint;
	};
	runnableProcesses: number;
}

export interface PidStatCaptures {
	pid: number;
	before: ProbeCapture;
	after?: ProbeCapture;
	kernelBootId?: string | null;
}

export interface AmdSmiCaptures {
	list: ProbeCapture;
	metrics: ProbeCapture;
	processes: ProbeCapture;
	/** Optional captured debugfs file manifest. Never admission-bearing. */
	kfd?: ProbeCapture;
	pidStarts?:
		| ReadonlyMap<number, PidStartEvidence>
		| Record<number, PidStartEvidence>;
}

export interface AmdKfdFallbackCaptures {
	topology: ProbeCapture;
	kfd: ProbeCapture;
	pidStarts?:
		| ReadonlyMap<number, PidStartEvidence>
		| Record<number, PidStartEvidence>;
}

export interface AmdGpuTopCaptures extends AmdKfdFallbackCaptures {
	metrics: ProbeCapture;
}

export interface NvidiaSmiCaptures {
	/** nvidia-smi -L; required so hidden MIG partitions cannot be missed. */
	listing: ProbeCapture;
	/** pci.bus_id,uuid,utilization.gpu,memory.used CSV, no header/no units. */
	metrics: ProbeCapture;
	/** gpu_uuid,pid,used_gpu_memory CSV, no header/no units. */
	processes: ProbeCapture;
	/** nvidia-smi -q -x process surface, including C/G/M/O context types. */
	contexts?: ProbeCapture;
	pidStarts?:
		| ReadonlyMap<number, PidStartEvidence>
		| Record<number, PidStartEvidence>;
}

function diag(
	code: ProbeDiagnosticCode,
	message: string,
	field?: string,
): ProbeDiagnostic {
	const unsupported =
		code === "unsupported-platform" ||
		code === "tool-missing" ||
		code === "tool-version-unsupported";
	const warning =
		code === "partial-observation" ||
		code === "pid-start-unavailable" ||
		code === "pid-reused-or-raced" ||
		code === "kfd-evidence-diagnostic-only";
	return {
		code,
		severity: unsupported || warning ? "warning" : "error",
		admissionEffect:
			code === "kfd-evidence-diagnostic-only" ||
			code === "pid-start-unavailable" ||
			code === "pid-reused-or-raced"
				? "degrade"
				: "block",
		message,
		...(field ? { field } : {}),
	};
}

function error<T>(diagnostic: ProbeDiagnostic): ProbeResult<T> {
	return { status: "error", value: null, diagnostics: [diagnostic] };
}

function unsupported<T>(diagnostic: ProbeDiagnostic): ProbeResult<T> {
	return { status: "unsupported", value: null, diagnostics: [diagnostic] };
}

function captureText<T>(
	capture: ProbeCapture,
	field: string,
): { ok: true; text: string } | { ok: false; result: ProbeResult<T> } {
	if (capture.truncated) {
		return {
			ok: false,
			result: error(
				diag("output-truncated", "Probe output was truncated", field),
			),
		};
	}
	if (capture.outcome !== "ok") {
		const mapping: Record<
			Exclude<ProbeCapture["outcome"], "ok">,
			[ProbeDiagnosticCode, string, "error" | "unsupported"]
		> = {
			"missing-tool": [
				"tool-missing",
				"Required probe tool is missing",
				"unsupported",
			],
			unsupported: [
				"tool-version-unsupported",
				"Probe tool or host surface is unsupported",
				"unsupported",
			],
			"permission-denied": [
				"permission-denied",
				"Probe did not have permission to observe all required data",
				"error",
			],
			timeout: ["probe-timeout", "Probe exceeded its time budget", "error"],
			"execution-error": ["execution-failed", "Probe command failed", "error"],
		};
		const [code, message, status] = mapping[capture.outcome];
		const diagnostic = diag(code, message, field);
		return {
			ok: false,
			result:
				status === "unsupported"
					? unsupported<T>(diagnostic)
					: error<T>(diagnostic),
		};
	}
	const text = capture.stdout;
	if (
		new TextEncoder().encode(text).byteLength >
		HOST_PROBE_PARSE_LIMITS.maxInputBytes
	) {
		return {
			ok: false,
			result: error(
				diag(
					"output-too-large",
					"Probe output exceeds parser byte limit",
					field,
				),
			),
		};
	}
	return { ok: true, text };
}

function boundedLines<T>(
	capture: ProbeCapture,
	field: string,
): { ok: true; lines: string[] } | { ok: false; result: ProbeResult<T> } {
	const captured = captureText<T>(capture, field);
	if (!captured.ok) return captured;
	const lines = captured.text.split(/\r?\n/);
	if (lines.length > HOST_PROBE_PARSE_LIMITS.maxLines) {
		return {
			ok: false,
			result: error(
				diag("too-many-records", "Probe output has too many lines", field),
			),
		};
	}
	if (
		lines.some(
			(line) =>
				new TextEncoder().encode(line).byteLength >
				HOST_PROBE_PARSE_LIMITS.maxLineBytes,
		)
	) {
		return {
			ok: false,
			result: error(
				diag("line-too-long", "Probe output contains an oversized line", field),
			),
		};
	}
	return { ok: true, lines };
}

function parseUnsignedBigInt(value: string): bigint | null {
	if (!/^\d+$/.test(value)) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function parseFiniteNumber(value: string): number | null {
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : null;
}

function parseNonNegativeInteger(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseProcStat(
	capture: ProbeCapture,
): ProbeResult<ProcStatSnapshot> {
	const bounded = boundedLines<ProcStatSnapshot>(capture, "proc-stat");
	if (!bounded.ok) return bounded.result;
	let aggregate: ProcStatSnapshot["cpu"] | null = null;
	let runnable: number | null = null;
	const logical = new Set<number>();
	for (const raw of bounded.lines) {
		const line = raw.trim();
		if (!line) continue;
		const fields = line.split(/\s+/);
		if (fields[0] === "cpu") {
			if (aggregate) {
				return error(
					diag("malformed-output", "Duplicate aggregate CPU row", "cpu"),
				);
			}
			if (fields.length < 9) {
				return error(
					diag("missing-field", "Aggregate CPU row is incomplete", "cpu"),
				);
			}
			const counters = fields.slice(1, 9).map(parseUnsignedBigInt);
			if (counters.some((counter) => counter === null)) {
				return error(
					diag(
						"invalid-value",
						"CPU counter is not an unsigned integer",
						"cpu",
					),
				);
			}
			const [user, nice, system, idle, iowait, irq, softirq, steal] = counters;
			if (
				user === null ||
				user === undefined ||
				nice === null ||
				nice === undefined ||
				system === null ||
				system === undefined ||
				idle === null ||
				idle === undefined ||
				iowait === null ||
				iowait === undefined ||
				irq === null ||
				irq === undefined ||
				softirq === null ||
				softirq === undefined ||
				steal === null ||
				steal === undefined
			) {
				return error(
					diag("missing-field", "Aggregate CPU row is incomplete", "cpu"),
				);
			}
			aggregate = { user, nice, system, idle, iowait, irq, softirq, steal };
			continue;
		}
		const cpuMatch = /^cpu(\d+)$/.exec(fields[0] ?? "");
		if (cpuMatch) {
			const index = Number(cpuMatch[1]);
			if (!Number.isSafeInteger(index) || logical.has(index)) {
				return error(
					diag(
						"malformed-output",
						"Duplicate or invalid logical CPU row",
						fields[0],
					),
				);
			}
			logical.add(index);
			continue;
		}
		if (fields[0] === "procs_running") {
			if (runnable !== null || fields.length !== 2) {
				return error(
					diag(
						"malformed-output",
						"Invalid procs_running row",
						"procs_running",
					),
				);
			}
			runnable = parseNonNegativeInteger(fields[1]);
			if (runnable === null) {
				return error(
					diag(
						"invalid-value",
						"procs_running is not an unsigned integer",
						"procs_running",
					),
				);
			}
		}
	}
	if (!aggregate || logical.size === 0 || runnable === null) {
		return error(
			diag(
				"missing-field",
				"proc/stat must include aggregate CPU, logical CPUs, and procs_running",
				"proc-stat",
			),
		);
	}
	return {
		status: "ok",
		value: {
			logicalProcessors: logical.size,
			cpu: aggregate,
			runnableProcesses: runnable,
		},
		diagnostics: [],
	};
}

export function parseLinuxCpuDiscovery(
	capture: ProbeCapture,
): ProbeResult<LinuxCpuDiscovery> {
	const parsed = parseProcStat(capture);
	if (parsed.status !== "ok" && parsed.status !== "degraded") return parsed;
	return {
		status: parsed.status,
		value: { logicalProcessors: parsed.value.logicalProcessors },
		diagnostics: parsed.diagnostics,
	};
}

function cpuTotal(cpu: ProcStatSnapshot["cpu"]): bigint {
	// Linux documents iowait as an unreliable counter which can decrease. Keep
	// it observable in the raw snapshot, but exclude it from the bounded busy
	// ratio so it is never presented as precise usable CPU capacity.
	return (
		cpu.user +
		cpu.nice +
		cpu.system +
		cpu.idle +
		cpu.irq +
		cpu.softirq +
		cpu.steal
	);
}

export function parseLinuxCpuPressure(
	previous: ProbeCapture,
	current: ProbeCapture,
): ProbeResult<LinuxCpuPressure> {
	const before = parseProcStat(previous);
	if (before.status !== "ok" && before.status !== "degraded") return before;
	const after = parseProcStat(current);
	if (after.status !== "ok" && after.status !== "degraded") return after;
	const names = (
		Object.keys(before.value.cpu) as (keyof ProcStatSnapshot["cpu"])[]
	).filter((name) => name !== "iowait");
	if (names.some((name) => after.value.cpu[name] < before.value.cpu[name])) {
		return error(
			diag(
				"counter-regressed",
				"CPU counters regressed between samples",
				"cpu",
			),
		);
	}
	const totalDelta = cpuTotal(after.value.cpu) - cpuTotal(before.value.cpu);
	if (totalDelta <= 0n) {
		return error(
			diag("invalid-value", "CPU sample has no positive counter delta", "cpu"),
		);
	}
	const idleDelta = after.value.cpu.idle - before.value.cpu.idle;
	const busyDelta = totalDelta - idleDelta;
	const busyFraction = Number(busyDelta) / Number(totalDelta);
	if (!Number.isFinite(busyFraction) || busyFraction < 0 || busyFraction > 1) {
		return error(
			diag("invalid-value", "CPU busy fraction is outside 0..1", "cpu"),
		);
	}
	return {
		status: "ok",
		value: {
			busyFraction,
			runnableProcesses: after.value.runnableProcesses,
		},
		diagnostics: [],
	};
}

export function parseProcMeminfo(
	capture: ProbeCapture,
): ProbeResult<LinuxMemoryObservation> {
	const bounded = boundedLines<LinuxMemoryObservation>(capture, "proc-meminfo");
	if (!bounded.ok) return bounded.result;
	const values = new Map<string, bigint>();
	const required = new Set([
		"MemTotal",
		"MemAvailable",
		"SwapTotal",
		"SwapFree",
	]);
	for (const raw of bounded.lines) {
		const match = /^\s*([A-Za-z]+):\s+(\S+)\s+(\S+)\s*$/.exec(raw);
		const field = match?.[1];
		if (!field || !required.has(field)) continue;
		if (values.has(field)) {
			return error(diag("malformed-output", `Duplicate ${field} field`, field));
		}
		const amount = match[2] ?? "";
		const unit = match[3] ?? "";
		const parsed = parseUnsignedBigInt(amount);
		if (parsed === null) {
			return error(
				diag("invalid-value", `${field} is not an unsigned integer`, field),
			);
		}
		if (unit !== "kB") {
			return error(
				diag("invalid-unit", `${field} must use procfs kB (KiB) units`, field),
			);
		}
		const bytes = parsed * 1024n;
		// SQLite and several downstream process APIs use signed 64-bit byte
		// quantities. Reject impossible/corrupt procfs values before they cross
		// that persistence boundary.
		if (bytes > 9_223_372_036_854_775_807n) {
			return error(
				diag("invalid-value", `${field} overflows signed 64-bit bytes`, field),
			);
		}
		values.set(field, bytes);
	}
	if ([...required].some((field) => !values.has(field))) {
		return error(
			diag(
				"missing-field",
				"MemTotal, MemAvailable, SwapTotal, and SwapFree are required",
				"proc-meminfo",
			),
		);
	}
	const total = values.get("MemTotal") as bigint;
	const available = values.get("MemAvailable") as bigint;
	const swapTotal = values.get("SwapTotal") as bigint;
	const swapFree = values.get("SwapFree") as bigint;
	if (available > total || swapFree > swapTotal) {
		return error(
			diag(
				"invalid-value",
				"Available memory or free swap exceeds its total",
				"proc-meminfo",
			),
		);
	}
	return {
		status: "ok",
		value: {
			memTotalBytes: total,
			memAvailableBytes: available,
			swapTotalBytes: swapTotal,
			swapFreeBytes: swapFree,
			scope: "host",
		},
		diagnostics: [],
	};
}

function parsePidStat(pid: number, text: string): bigint | null {
	const close = text.lastIndexOf(")");
	const open = text.indexOf("(");
	if (open < 1 || close <= open) return null;
	if (parseNonNegativeInteger(text.slice(0, open).trim()) !== pid) return null;
	const tail = text
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	// tail[0] is field 3 (state), so Linux proc(5) field 22 is tail[19].
	return tail.length > 19 ? parseUnsignedBigInt(tail[19] ?? "") : null;
}

function unavailablePidStart(
	pid: number,
	reason: "permission-denied" | "process-missing" | "malformed-stat",
): ProbeResult<PidStartEvidence> {
	return {
		status: "degraded",
		value: { status: "unavailable", pid, reason },
		diagnostics: [
			diag(
				"pid-start-unavailable",
				`PID start evidence is unavailable: ${reason}`,
				"proc-pid-stat",
			),
		],
	};
}

export function parsePidStartEvidence(
	captures: PidStatCaptures,
): ProbeResult<PidStartEvidence> {
	if (!Number.isSafeInteger(captures.pid) || captures.pid <= 0) {
		return error(
			diag("invalid-value", "PID must be a positive safe integer", "pid"),
		);
	}
	if (captures.before.outcome === "permission-denied") {
		return unavailablePidStart(captures.pid, "permission-denied");
	}
	if (captures.before.outcome === "execution-error") {
		return unavailablePidStart(captures.pid, "process-missing");
	}
	const beforeCapture = captureText<PidStartEvidence>(
		captures.before,
		"proc-pid-stat",
	);
	if (!beforeCapture.ok) return beforeCapture.result;
	const before = parsePidStat(captures.pid, beforeCapture.text.trim());
	if (before === null)
		return unavailablePidStart(captures.pid, "malformed-stat");
	if (captures.after) {
		if (captures.after.outcome === "permission-denied") {
			return unavailablePidStart(captures.pid, "permission-denied");
		}
		if (captures.after.outcome === "execution-error") {
			return unavailablePidStart(captures.pid, "process-missing");
		}
		const afterCapture = captureText<PidStartEvidence>(
			captures.after,
			"proc-pid-stat",
		);
		if (!afterCapture.ok) return afterCapture.result;
		const after = parsePidStat(captures.pid, afterCapture.text.trim());
		if (after === null)
			return unavailablePidStart(captures.pid, "malformed-stat");
		if (after !== before) {
			return {
				status: "degraded",
				value: {
					status: "raced",
					pid: captures.pid,
					beforeStartTimeTicks: before,
					afterStartTimeTicks: after,
				},
				diagnostics: [
					diag(
						"pid-reused-or-raced",
						"PID start time changed during observation",
						"proc-pid-stat",
					),
				],
			};
		}
	}
	return {
		status: "ok",
		value: {
			status: "verified",
			pid: captures.pid,
			startTimeTicks: before,
			kernelBootId: captures.kernelBootId ?? null,
		},
		diagnostics: [],
	};
}

export function canonicalizePciAddress(value: string): string | null {
	const match =
		/^([0-9a-fA-F]{4}|[0-9a-fA-F]{8}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$/.exec(
			value.trim(),
		);
	if (!match) return null;
	const domain = (match[1] ?? "").slice(-4).toLowerCase();
	return `${domain}:${(match[2] ?? "").toLowerCase()}:${(match[3] ?? "").toLowerCase()}.${match[4] ?? ""}`;
}

function stableUuid(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(trimmed) ? trimmed : null;
}

function stableKey(identity: Omit<GpuDeviceIdentity, "key">): string {
	const partition = identity.partition
		? `:${identity.partition.kind}:${identity.partition.id}:${identity.partition.uuid ?? "no-uuid"}`
		: "";
	return `gpu:${identity.vendor}:${identity.pciAddress}:${identity.uuid}${partition}`;
}

function unknownPidStart(pid: number): PidStartEvidence {
	return { status: "unavailable", pid, reason: "not-sampled" };
}

function pidStartFor(
	pid: number,
	starts: AmdSmiCaptures["pidStarts"] | NvidiaSmiCaptures["pidStarts"],
): PidStartEvidence {
	if (!starts) return unknownPidStart(pid);
	if ("get" in starts && typeof starts.get === "function") {
		return starts.get(pid) ?? unknownPidStart(pid);
	}
	return (
		(starts as Record<number, PidStartEvidence>)[pid] ?? unknownPidStart(pid)
	);
}

function parseJson<T>(
	capture: ProbeCapture,
	field: string,
): { ok: true; value: unknown } | { ok: false; result: ProbeResult<T> } {
	const captured = captureText<T>(capture, field);
	if (!captured.ok) return captured;
	try {
		return { ok: true, value: JSON.parse(captured.text) };
	} catch {
		return {
			ok: false,
			result: error(
				diag("malformed-output", "Probe output is not valid JSON", field),
			),
		};
	}
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function records(
	value: unknown,
	wrapper?: string,
): Record<string, unknown>[] | null {
	const candidate = wrapper && object(value) ? object(value)?.[wrapper] : value;
	if (
		!Array.isArray(candidate) ||
		candidate.length > HOST_PROBE_PARSE_LIMITS.maxRecords
	)
		return null;
	const result = candidate.map(object);
	return result.every((entry) => entry !== null)
		? (result as Record<string, unknown>[])
		: null;
}

function quantityBytes(value: unknown): ByteCount | null {
	const wrapped = object(value);
	const amount = wrapped ? wrapped.value : value;
	const unit = wrapped ? wrapped.unit : "B";
	const integer =
		typeof amount === "bigint"
			? amount
			: typeof amount === "number" && Number.isSafeInteger(amount)
				? BigInt(amount)
				: typeof amount === "string"
					? parseUnsignedBigInt(amount.trim())
					: null;
	if (integer === null || integer < 0n || typeof unit !== "string") return null;
	const multiplier: Record<string, bigint> = {
		B: 1n,
		KiB: 1024n,
		MiB: 1024n ** 2n,
		GiB: 1024n ** 3n,
	};
	return multiplier[unit] === undefined ? null : integer * multiplier[unit];
}

function percentFraction(value: unknown): number | null {
	const wrapped = object(value);
	const raw = wrapped ? wrapped.value : value;
	const parsed =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Number(raw)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
		? parsed / 100
		: null;
}

function gpuObservation(
	identity: Omit<GpuDeviceIdentity, "key">,
	utilization: number | null,
	memoryUsedBytes: bigint | null,
	telemetry: {
		memoryTotalBytes?: bigint | null;
		temperatureCelsius?: number | null;
		powerWatts?: number | null;
	} = {},
): GpuDeviceObservation {
	const deviceEvidence: GpuOccupancyEvidence[] =
		memoryUsedBytes !== null && memoryUsedBytes > 0n
			? [
					{
						kind: "device-memory",
						source:
							identity.vendor === "amd"
								? "amd-smi-device"
								: "nvidia-smi-device",
						admission: "blocking",
						residentBytes: memoryUsedBytes,
					},
				]
			: [];
	return {
		identity: { ...identity, key: stableKey(identity) },
		gpuUtilization: utilization,
		memoryUsedBytes,
		memoryTotalBytes: telemetry.memoryTotalBytes ?? null,
		temperatureCelsius: telemetry.temperatureCelsius ?? null,
		powerWatts: telemetry.powerWatts ?? null,
		occupancy: {
			state: deviceEvidence.length > 0 ? "occupied" : "idle",
			occupants: [],
			deviceEvidence,
			blocksExclusiveAdmission: deviceEvidence.length > 0,
		},
	};
}

function finiteWrappedNumber(value: unknown, unit: string): number | null {
	const wrapped = object(value);
	if (!wrapped || wrapped.unit !== unit) return null;
	const number = wrapped.value;
	return typeof number === "number" && Number.isFinite(number) && number >= 0
		? number
		: null;
}

/**
 * Enrich the conservative KFD occupancy fallback with amdgpu_top's bounded
 * display telemetry. Utilization and sensors never weaken the KFD admission
 * result: a zero-percent GPU with a live context remains unknown/blocked.
 */
export function parseAmdGpuTop(
	captures: AmdGpuTopCaptures,
): ProbeResult<GpuDeviceObservation[]> {
	const fallback = parseAmdKfdFallback(captures);
	if (fallback.status !== "ok" && fallback.status !== "degraded")
		return fallback;
	const parsed = parseJson<GpuDeviceObservation[]>(
		captures.metrics,
		"amdgpu-top-metrics",
	);
	if (!parsed.ok) return parsed.result;
	const root = object(parsed.value);
	if (
		!root ||
		!Array.isArray(root.devices) ||
		root.devices.length === 0 ||
		root.devices.length > HOST_PROBE_PARSE_LIMITS.maxRecords
	) {
		return error(
			diag(
				"malformed-output",
				"amdgpu_top JSON has no bounded device list",
				"amdgpu-top-metrics",
			),
		);
	}
	const telemetry = new Map<
		string,
		{
			utilization: number | null;
			memoryUsedBytes: bigint | null;
			memoryTotalBytes: bigint | null;
			apuGttTotalBytes: bigint | null;
			temperatureCelsius: number | null;
			powerWatts: number | null;
		}
	>();
	for (const raw of root.devices) {
		const device = object(raw);
		const info = object(device?.Info);
		const pci =
			typeof info?.PCI === "string" ? canonicalizePciAddress(info.PCI) : null;
		const activity = object(device?.gpu_activity);
		const vram = object(device?.VRAM);
		const sensors = object(device?.Sensors);
		if (!device || !pci || telemetry.has(pci) || !activity || !vram) {
			return error(
				diag(
					"malformed-output",
					"amdgpu_top device telemetry is incomplete or ambiguous",
					"amdgpu-top-metrics",
				),
			);
		}
		const utilization = percentFraction(activity.GFX);
		const apu = info?.["GPU Type"] === "APU";
		const gttTotal = quantityBytes(vram["Total GTT"]);
		const vramUsed = quantityBytes(vram["Total VRAM Usage"]);
		const vramTotal = quantityBytes(vram["Total VRAM"]);
		if (
			utilization === null ||
			vramUsed === null ||
			vramTotal === null ||
			(apu && gttTotal === null)
		) {
			return error(
				diag(
					"invalid-value",
					"amdgpu_top reported invalid utilization or memory values",
					"amdgpu-top-metrics",
				),
			);
		}
		telemetry.set(pci, {
			utilization,
			memoryUsedBytes: vramUsed,
			memoryTotalBytes: vramTotal,
			apuGttTotalBytes: apu ? gttTotal : null,
			temperatureCelsius: finiteWrappedNumber(
				sensors?.["Edge Temperature"],
				"C",
			),
			powerWatts:
				finiteWrappedNumber(sensors?.["GFX Power"], "W") ??
				finiteWrappedNumber(sensors?.["Average Power"], "W"),
		});
	}
	if (
		fallback.value.length !== telemetry.size ||
		fallback.value.some((device) => !telemetry.has(device.identity.pciAddress))
	) {
		return error(
			diag(
				"ambiguous-identity",
				"amdgpu_top devices do not map one-to-one to KFD PCI identities",
				"amdgpu-top-metrics",
			),
		);
	}
	for (const device of fallback.value) {
		const metrics = telemetry.get(device.identity.pciAddress);
		if (!metrics) continue;
		device.gpuUtilization = metrics.utilization;
		if (metrics.apuGttTotalBytes !== null) {
			// APUs expose only a small dedicated VRAM window while compute allocations
			// reside in the unified GTT aperture. KFD is the trustworthy per-process
			// resident total; amdgpu_top supplies the aperture size.
			const kfdResidentBytes = device.occupancy.occupants
				.flatMap((occupant) => occupant.evidence)
				.reduce(
					(total, evidence) =>
						evidence.kind === "device-memory" &&
						(evidence.source === "linux-kfd-debugfs" ||
							evidence.source === "linux-kfd-sysfs")
							? total + evidence.residentBytes
							: total,
					0n,
				);
			device.memoryUsedBytes =
				kfdResidentBytes > 0n ? kfdResidentBytes : metrics.memoryUsedBytes;
			device.memoryTotalBytes = metrics.apuGttTotalBytes;
		} else {
			device.memoryUsedBytes = metrics.memoryUsedBytes;
			device.memoryTotalBytes = metrics.memoryTotalBytes;
		}
		device.temperatureCelsius = metrics.temperatureCelsius;
		device.powerWatts = metrics.powerWatts;
	}
	return {
		...fallback,
		diagnostics: fallback.diagnostics.map((diagnostic) =>
			diagnostic.code === "partial-observation"
				? {
						...diagnostic,
						message:
							"amd-smi is unavailable; amdgpu_top supplies live utilization while KFD occupancy remains conservative",
						field: "amdgpu-top+kfd",
					}
				: diagnostic,
		),
	};
}

function addEvidence(
	device: GpuDeviceObservation,
	pid: number,
	evidence: GpuOccupancyEvidence,
	start: PidStartEvidence,
): void {
	let occupant = device.occupancy.occupants.find((entry) => entry.pid === pid);
	if (!occupant) {
		occupant = { pid, pidStart: start, attribution: "unknown", evidence: [] };
		device.occupancy.occupants.push(occupant);
	}
	if (
		!occupant.evidence.some(
			(item) =>
				item.kind === evidence.kind &&
				item.source === evidence.source &&
				("contextKind" in item ? item.contextKind : undefined) ===
					("contextKind" in evidence ? evidence.contextKind : undefined) &&
				("residentBytes" in item ? item.residentBytes : undefined) ===
					("residentBytes" in evidence ? evidence.residentBytes : undefined) &&
				("queueId" in item ? item.queueId : undefined) ===
					("queueId" in evidence ? evidence.queueId : undefined),
		)
	) {
		occupant.evidence.push(evidence);
	}
	if (evidence.admission === "blocking") {
		device.occupancy.state = "occupied";
		device.occupancy.blocksExclusiveAdmission = true;
	} else if (device.occupancy.state === "idle") {
		device.occupancy.state = "unknown";
	}
}

interface AmdDeviceRecord {
	index: number;
	bdf: string;
	uuid: string;
	kfdId: string | null;
	partitionId: string | null;
}

function amdListRecords(value: unknown): AmdDeviceRecord[] | null {
	const input = records(value) ?? records(value, "gpu_data");
	if (!input) return null;
	const result: AmdDeviceRecord[] = [];
	for (const entry of input) {
		const index = parseNonNegativeInteger(entry.gpu ?? entry.GPU);
		const bdfRaw = entry.bdf ?? entry.BDF;
		const uuid = stableUuid(entry.uuid ?? entry.UUID);
		const bdf =
			typeof bdfRaw === "string" ? canonicalizePciAddress(bdfRaw) : null;
		if (index === null || !bdf || !uuid) return null;
		const kfdRaw = entry.kfd_id ?? entry.KFD_ID;
		const partitionRaw = entry.partition_id ?? entry.PARTITION_ID;
		const kfdId =
			kfdRaw === undefined || kfdRaw === null ? null : String(kfdRaw);
		const partitionId =
			partitionRaw === undefined ||
			partitionRaw === null ||
			partitionRaw === "N/A"
				? null
				: String(partitionRaw);
		result.push({ index, bdf, uuid, kfdId, partitionId });
	}
	return result;
}

function amdMetricMap(
	value: unknown,
): Map<number, { utilization: number | null; memory: bigint | null }> | null {
	const input = records(value) ?? records(value, "gpu_data");
	if (!input) return null;
	const result = new Map<
		number,
		{ utilization: number | null; memory: bigint | null }
	>();
	for (const entry of input) {
		const index = parseNonNegativeInteger(entry.gpu ?? entry.GPU);
		if (index === null || result.has(index)) return null;
		const usage = object(entry.usage ?? entry.USAGE);
		const vram = object(entry.vram ?? entry.VRAM ?? entry.vram_usage);
		const utilizationRaw =
			usage?.gfx_activity ?? entry.gfx_activity ?? entry.GFX;
		const memoryRaw = vram?.used ?? entry.vram_used ?? entry.VRAM_USED;
		if (utilizationRaw === undefined || memoryRaw === undefined) return null;
		const utilization = percentFraction(utilizationRaw);
		const memory = quantityBytes(memoryRaw);
		if (utilization === null || memory === null) return null;
		result.set(index, { utilization, memory });
	}
	return result;
}

interface AmdProcessRecord {
	index: number;
	pid: number;
	vram: bigint | null;
	gtt: bigint | null;
	cuFraction: number | null;
}

function amdProcessRecords(
	value: unknown,
): { records: AmdProcessRecord[]; indexes: Set<number> } | null {
	const devices = records(value) ?? records(value, "gpu_data");
	if (!devices) return null;
	const result: AmdProcessRecord[] = [];
	const indexes = new Set<number>();
	for (const device of devices) {
		const index = parseNonNegativeInteger(device.gpu ?? device.GPU);
		const processList = device.process_list ?? device.PROCESS_LIST;
		if (
			index === null ||
			indexes.has(index) ||
			!Array.isArray(processList) ||
			processList.length > HOST_PROBE_PARSE_LIMITS.maxRecords
		)
			return null;
		indexes.add(index);
		for (const rawProcess of processList) {
			const process = object(rawProcess);
			const info =
				object(process?.process_info ?? process?.PROCESS_INFO) ?? process;
			if (!info) return null;
			const pid = parseNonNegativeInteger(info.pid ?? info.PID);
			if (pid === null || pid === 0) return null;
			const memoryUsage = object(info.memory_usage ?? info.MEMORY_USAGE);
			const vramRaw =
				memoryUsage?.vram_mem ?? memoryUsage?.VRAM_MEM ?? info.vram_mem;
			const gttRaw =
				memoryUsage?.gtt_mem ?? memoryUsage?.GTT_MEM ?? info.gtt_mem;
			const totalRaw = info.mem_usage ?? info.MEM_USAGE;
			const vram =
				vramRaw !== undefined
					? quantityBytes(vramRaw)
					: totalRaw !== undefined
						? quantityBytes(totalRaw)
						: null;
			if ((vramRaw !== undefined || totalRaw !== undefined) && vram === null)
				return null;
			const gtt = gttRaw === undefined ? null : quantityBytes(gttRaw);
			if (gttRaw !== undefined && gtt === null) return null;
			const cuRaw = info.cu_occupancy ?? info.CU_OCCUPANCY;
			const cuFraction = cuRaw === undefined ? null : percentFraction(cuRaw);
			if (cuRaw !== undefined && cuFraction === null) return null;
			result.push({ index, pid, vram, gtt, cuFraction });
			if (result.length > HOST_PROBE_PARSE_LIMITS.maxRecords) return null;
		}
	}
	return { records: result, indexes };
}

function validateUniqueDevices(
	devices: readonly GpuDeviceObservation[],
): ProbeDiagnostic | null {
	const keys = new Set<string>();
	const uuids = new Set<string>();
	for (const device of devices) {
		if (keys.has(device.identity.key) || uuids.has(device.identity.uuid)) {
			return diag(
				"duplicate-identity",
				"GPU identity appears more than once",
				"gpu-identity",
			);
		}
		keys.add(device.identity.key);
		uuids.add(device.identity.uuid);
	}
	return null;
}

type ParsedKfdSource = "linux-kfd-debugfs" | "linux-kfd-sysfs";

function parseKfdManifest(value: unknown): {
	queues: {
		pid: number;
		queueId: string;
		gpuId: string;
		source: ParsedKfdSource;
	}[];
	memories: {
		pid: number;
		gpuId: string;
		residentBytes: bigint;
		source: ParsedKfdSource;
	}[];
} | null {
	const root = object(value);
	if (
		!root ||
		!Array.isArray(root.files) ||
		root.files.length > HOST_PROBE_PARSE_LIMITS.maxRecords
	)
		return null;
	const queues: {
		pid: number;
		queueId: string;
		gpuId: string;
		source: ParsedKfdSource;
	}[] = [];
	const memories: {
		pid: number;
		gpuId: string;
		residentBytes: bigint;
		source: ParsedKfdSource;
	}[] = [];
	let manifestRoot: string | null = null;
	for (const raw of root.files) {
		const file = object(raw);
		if (
			!file ||
			typeof file.path !== "string" ||
			typeof file.content !== "string"
		)
			return null;
		const queueMatch =
			/^(\/sys\/(?:kernel\/debug\/kfd|class\/kfd\/kfd)\/proc)\/(\d+)\/queues\/([^/]{1,128})\/gpuid$/.exec(
				file.path,
			);
		const memoryMatch =
			/^(\/sys\/(?:kernel\/debug\/kfd|class\/kfd\/kfd)\/proc)\/(\d+)\/vram_(\d+)$/.exec(
				file.path,
			);
		const matchedRoot = queueMatch?.[1] ?? memoryMatch?.[1] ?? null;
		if (!matchedRoot || (manifestRoot !== null && matchedRoot !== manifestRoot))
			return null;
		manifestRoot = matchedRoot;
		const source: ParsedKfdSource = matchedRoot.includes("/class/")
			? "linux-kfd-sysfs"
			: "linux-kfd-debugfs";
		if (queueMatch) {
			const gpuId = file.content.trim();
			const pid = parseNonNegativeInteger(queueMatch[2]);
			if (pid === null || pid === 0 || !/^\d+$/.test(gpuId)) return null;
			queues.push({ pid, queueId: queueMatch[3] ?? "", gpuId, source });
			continue;
		}
		if (memoryMatch) {
			const pid = parseNonNegativeInteger(memoryMatch[2]);
			const residentBytes = parseUnsignedBigInt(file.content.trim());
			if (pid === null || pid === 0 || residentBytes === null) return null;
			memories.push({
				pid,
				gpuId: memoryMatch[3] ?? "",
				residentBytes,
				source,
			});
			continue;
		}
		return null;
	}
	return { queues, memories };
}

interface KfdTopologyDevice {
	gpuId: string;
	pciAddress: string;
}

function parseKfdTopology(value: unknown): KfdTopologyDevice[] | null {
	const root = object(value);
	if (
		!root ||
		!Array.isArray(root.nodes) ||
		root.nodes.length > HOST_PROBE_PARSE_LIMITS.maxRecords
	)
		return null;
	const devices: KfdTopologyDevice[] = [];
	for (const raw of root.nodes) {
		const node = object(raw);
		if (
			!node ||
			typeof node.gpuId !== "string" ||
			typeof node.properties !== "string"
		)
			return null;
		const gpuId = node.gpuId.trim();
		if (!/^\d+$/.test(gpuId)) return null;
		if (gpuId === "0") continue;
		const properties = new Map<string, string>();
		for (const line of node.properties.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const match = /^([a-z0-9_]+)\s+(\d+)$/.exec(line.trim());
			if (!match) return null;
			properties.set(match[1] ?? "", match[2] ?? "");
		}
		const vendor = Number(properties.get("vendor_id"));
		const domain = Number(properties.get("domain"));
		const location = Number(properties.get("location_id"));
		if (
			vendor !== 0x1002 ||
			!Number.isSafeInteger(domain) ||
			domain < 0 ||
			domain > 0xffff ||
			!Number.isSafeInteger(location) ||
			location < 0 ||
			location > 0xffff
		)
			return null;
		const bus = (location >> 8) & 0xff;
		const device = (location >> 3) & 0x1f;
		const fn = location & 0x7;
		const pciAddress = `${domain.toString(16).padStart(4, "0")}:${bus
			.toString(16)
			.padStart(2, "0")}:${device.toString(16).padStart(2, "0")}.${fn}`;
		devices.push({ gpuId, pciAddress });
	}
	if (devices.length === 0) return null;
	const ids = new Set(devices.map((device) => device.gpuId));
	const addresses = new Set(devices.map((device) => device.pciAddress));
	return ids.size === devices.length && addresses.size === devices.length
		? devices
		: null;
}

/**
 * Conservative fallback for hosts where KFD sysfs is readable but amd-smi is
 * not installed. KFD is non-atomic, so it can establish neither idle nor an
 * admission-bearing occupant. The resulting unknown state deliberately blocks
 * exclusive admission while still exposing the process/context evidence.
 */
export function parseAmdKfdFallback(
	captures: AmdKfdFallbackCaptures,
): ProbeResult<GpuDeviceObservation[]> {
	const topologyJson = parseJson<GpuDeviceObservation[]>(
		captures.topology,
		"kfd-topology",
	);
	if (!topologyJson.ok) return topologyJson.result;
	const topology = parseKfdTopology(topologyJson.value);
	if (!topology)
		return error(
			diag(
				"malformed-output",
				"KFD topology cannot be mapped to stable AMD PCI identities",
				"kfd-topology",
			),
		);
	const kfdJson = parseJson<GpuDeviceObservation[]>(captures.kfd, "kfd");
	if (!kfdJson.ok) return kfdJson.result;
	const evidence = parseKfdManifest(kfdJson.value);
	if (!evidence)
		return error(diag("malformed-output", "KFD manifest is malformed", "kfd"));
	const devices = topology.map((entry) =>
		gpuObservation(
			{
				vendor: "amd",
				pciAddress: entry.pciAddress,
				uuid: `KFD-PCI-${entry.pciAddress}`,
				partition: null,
				displayIndex: null,
			},
			null,
			null,
		),
	);
	const byGpuId = new Map(
		topology.map((entry, index) => [entry.gpuId, devices[index]] as const),
	);
	for (const queue of evidence.queues) {
		const device = byGpuId.get(queue.gpuId);
		if (!device)
			return error(
				diag(
					"ambiguous-identity",
					"KFD queue GPU ID has no stable topology mapping",
					"kfd",
				),
			);
		addEvidence(
			device,
			queue.pid,
			{
				kind: "hsa-queue",
				source: queue.source,
				admission: "diagnostic-only",
				queueId: queue.queueId,
			},
			pidStartFor(queue.pid, captures.pidStarts),
		);
	}
	for (const memory of evidence.memories) {
		const device = byGpuId.get(memory.gpuId);
		if (!device)
			return error(
				diag(
					"ambiguous-identity",
					"KFD memory GPU ID has no stable topology mapping",
					"kfd",
				),
			);
		if (memory.residentBytes > 0n)
			addEvidence(
				device,
				memory.pid,
				{
					kind: "device-memory",
					source: memory.source,
					admission: "diagnostic-only",
					residentBytes: memory.residentBytes,
					memoryKind: "vram",
				},
				pidStartFor(memory.pid, captures.pidStarts),
			);
	}
	for (const device of devices) {
		if (device.occupancy.state === "idle") device.occupancy.state = "unknown";
	}
	return {
		status: "degraded",
		value: devices,
		diagnostics: [
			{
				...diag(
					"partial-observation",
					"amd-smi is unavailable; KFD sysfs evidence cannot prove device idleness",
					"kfd",
				),
				severity: "warning",
			},
		],
	};
}

export function parseAmdSmi(
	captures: AmdSmiCaptures,
): ProbeResult<GpuDeviceObservation[]> {
	const listJson = parseJson<GpuDeviceObservation[]>(
		captures.list,
		"amd-smi-list",
	);
	if (!listJson.ok) return listJson.result;
	const metricJson = parseJson<GpuDeviceObservation[]>(
		captures.metrics,
		"amd-smi-metrics",
	);
	if (!metricJson.ok) return metricJson.result;
	const processJson = parseJson<GpuDeviceObservation[]>(
		captures.processes,
		"amd-smi-processes",
	);
	if (!processJson.ok) return processJson.result;
	const listed = amdListRecords(listJson.value);
	const metrics = amdMetricMap(metricJson.value);
	const processes = amdProcessRecords(processJson.value);
	if (!listed || !metrics || !processes || listed.length === 0) {
		return error(
			diag(
				"malformed-output",
				"AMD SMI output does not match the supported schema",
				"amd-smi",
			),
		);
	}
	const indexes = new Set<number>();
	const devices = listed.map((entry) => {
		indexes.add(entry.index);
		const metric = metrics.get(entry.index);
		const partition = entry.partitionId
			? {
					kind: "amd-compute-partition" as const,
					id: entry.partitionId,
					uuid: entry.uuid,
				}
			: null;
		return gpuObservation(
			{
				vendor: "amd",
				pciAddress: entry.bdf,
				uuid: entry.uuid,
				partition,
				displayIndex: entry.index,
			},
			metric?.utilization ?? null,
			metric?.memory ?? null,
		);
	});
	if (
		indexes.size !== listed.length ||
		metrics.size !== listed.length ||
		processes.indexes.size !== listed.length ||
		[...metrics.keys()].some((index) => !indexes.has(index)) ||
		[...processes.indexes].some((index) => !indexes.has(index))
	) {
		return error(
			diag(
				"ambiguous-identity",
				"AMD display indices do not map one-to-one to stable identities",
				"amd-smi",
			),
		);
	}
	const duplicate = validateUniqueDevices(devices);
	if (duplicate) return error(duplicate);
	const byIndex = new Map(
		devices.map((device) => [device.identity.displayIndex, device]),
	);
	for (const process of processes.records) {
		const device = byIndex.get(process.index);
		if (!device) {
			return error(
				diag(
					"ambiguous-identity",
					"AMD process references an unknown display index",
					"amd-smi-processes",
				),
			);
		}
		addEvidence(
			device,
			process.pid,
			{
				kind: "compute-context",
				source: "amd-smi-process",
				admission: "blocking",
				contextKind: "compute",
				...(process.cuFraction === null
					? {}
					: { computeUnitFraction: process.cuFraction }),
			},
			pidStartFor(process.pid, captures.pidStarts),
		);
		if (process.vram !== null && process.vram > 0n) {
			addEvidence(
				device,
				process.pid,
				{
					kind: "device-memory",
					source: "amd-smi-process",
					admission: "blocking",
					residentBytes: process.vram,
					memoryKind: "vram",
				},
				pidStartFor(process.pid, captures.pidStarts),
			);
		}
		if (process.gtt !== null && process.gtt > 0n) {
			addEvidence(
				device,
				process.pid,
				{
					kind: "device-memory",
					source: "amd-smi-process",
					admission: "blocking",
					residentBytes: process.gtt,
					memoryKind: "gtt",
				},
				pidStartFor(process.pid, captures.pidStarts),
			);
		}
	}

	const diagnostics: ProbeDiagnostic[] = [];
	if (captures.kfd) {
		if (captures.kfd.outcome !== "ok" || captures.kfd.truncated) {
			const code =
				captures.kfd.outcome === "permission-denied"
					? "permission-denied"
					: captures.kfd.outcome === "timeout"
						? "probe-timeout"
						: "partial-observation";
			diagnostics.push({
				...diag(
					code,
					"KFD augmentation is unavailable and cannot prove absence of queues",
					"kfd",
				),
				severity: "warning",
				admissionEffect: "degrade",
			});
			for (const device of devices) {
				if (device.occupancy.state === "idle")
					device.occupancy.state = "unknown";
			}
		} else {
			const kfdJson = parseJson<GpuDeviceObservation[]>(captures.kfd, "kfd");
			if (!kfdJson.ok) return kfdJson.result;
			const kfdEvidence = parseKfdManifest(kfdJson.value);
			if (!kfdEvidence)
				return error(
					diag("malformed-output", "KFD manifest is malformed", "kfd"),
				);
			const kfdMap = new Map<string, GpuDeviceObservation>();
			for (let i = 0; i < listed.length; i++) {
				const listedDevice = listed[i];
				const observedDevice = devices[i];
				if (!listedDevice || !observedDevice) {
					return error(
						diag(
							"ambiguous-identity",
							"KFD device mapping is incomplete",
							"kfd",
						),
					);
				}
				const kfdId = listedDevice.kfdId;
				if (kfdId) {
					if (kfdMap.has(kfdId)) {
						return error(
							diag(
								"ambiguous-identity",
								"KFD GPU ID maps to multiple stable devices",
								"kfd",
							),
						);
					}
					kfdMap.set(kfdId, observedDevice);
				}
			}
			for (const queue of kfdEvidence.queues) {
				const device = kfdMap.get(queue.gpuId);
				if (!device) {
					return error(
						diag(
							"ambiguous-identity",
							"KFD queue GPU ID has no stable AMD mapping",
							"kfd",
						),
					);
				}
				addEvidence(
					device,
					queue.pid,
					{
						kind: "hsa-queue",
						source: queue.source,
						admission: "diagnostic-only",
						queueId: queue.queueId,
					},
					pidStartFor(queue.pid, captures.pidStarts),
				);
			}
			for (const memory of kfdEvidence.memories) {
				const device = kfdMap.get(memory.gpuId);
				if (!device) {
					return error(
						diag(
							"ambiguous-identity",
							"KFD VRAM GPU ID has no stable AMD mapping",
							"kfd",
						),
					);
				}
				if (memory.residentBytes > 0n) {
					addEvidence(
						device,
						memory.pid,
						{
							kind: "device-memory",
							source: memory.source,
							admission: "diagnostic-only",
							residentBytes: memory.residentBytes,
							memoryKind: "vram",
						},
						pidStartFor(memory.pid, captures.pidStarts),
					);
				}
			}
			if (kfdEvidence.queues.length > 0 || kfdEvidence.memories.length > 0) {
				diagnostics.push(
					diag(
						"kfd-evidence-diagnostic-only",
						"KFD queue snapshots are non-atomic and cannot independently admit or deny work",
						"kfd",
					),
				);
			}
		}
	}
	return {
		status: diagnostics.length > 0 ? "degraded" : "ok",
		value: devices,
		diagnostics,
	};
}

function parseCsvLine(line: string): string[] | null {
	const fields: string[] = [];
	let current = "";
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (character === '"') {
			if (quoted && line[index + 1] === '"') {
				current += '"';
				index++;
			} else {
				quoted = !quoted;
			}
		} else if (character === "," && !quoted) {
			fields.push(current.trim());
			current = "";
		} else {
			current += character;
		}
	}
	if (quoted) return null;
	fields.push(current.trim());
	return fields;
}

function parseNvidiaListing(lines: readonly string[]): {
	physical: Map<number, string>;
	partitions: { parentIndex: number; id: string; uuid: string }[];
} | null {
	const physical = new Map<number, string>();
	const partitions: { parentIndex: number; id: string; uuid: string }[] = [];
	let parentIndex: number | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const gpu = /^GPU\s+(\d+):\s+.*\(UUID:\s*([^\s)]+)\)\s*$/.exec(line);
		if (gpu) {
			parentIndex = parseNonNegativeInteger(gpu[1]);
			const uuid = stableUuid(gpu[2]);
			if (parentIndex === null || !uuid || physical.has(parentIndex))
				return null;
			physical.set(parentIndex, uuid);
			if (
				physical.size + partitions.length >
				HOST_PROBE_PARSE_LIMITS.maxRecords
			)
				return null;
			continue;
		}
		const mig = /^MIG\s+.+?\s+Device\s+(\d+):\s+\(UUID:\s*([^\s)]+)\)\s*$/.exec(
			line,
		);
		if (mig && parentIndex !== null) {
			const uuid = stableUuid(mig[2]);
			if (!uuid) return null;
			partitions.push({ parentIndex, id: mig[1] ?? "", uuid });
			if (
				physical.size + partitions.length >
				HOST_PROBE_PARSE_LIMITS.maxRecords
			)
				return null;
			continue;
		}
		return null;
	}
	return physical.size > 0 ? { physical, partitions } : null;
}

function xmlText(block: string, tag: string): string | null {
	const match = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`).exec(block);
	return match?.[1]?.trim() ?? null;
}

function nvidiaContextKind(
	type: string,
): "compute" | "graphics" | "mps" | "other" | null {
	if (type === "C" || type === "C+G") return "compute";
	if (type === "G") return "graphics";
	if (type === "M" || type === "M+C") return "mps";
	if (type === "O") return "other";
	return null;
}

function addNvidiaXmlContexts(
	capture: ProbeCapture,
	byUuid: ReadonlyMap<string, GpuDeviceObservation>,
	starts: NvidiaSmiCaptures["pidStarts"],
): ProbeResult<null> {
	const captured = captureText<null>(capture, "nvidia-smi-contexts");
	if (!captured.ok) return captured.result;
	const xml = captured.text;
	if (!/^\s*<\?xml\b/.test(xml) || /<!DOCTYPE/i.test(xml)) {
		return error(
			diag(
				"malformed-output",
				"NVIDIA context output is not supported bounded XML",
				"nvidia-smi-contexts",
			),
		);
	}
	const gpuBlocks = [...xml.matchAll(/<gpu(?:\s+[^>]*)?>([\s\S]*?)<\/gpu>/g)];
	if (
		gpuBlocks.length === 0 ||
		gpuBlocks.length > HOST_PROBE_PARSE_LIMITS.maxRecords
	)
		return error(
			diag(
				"malformed-output",
				"NVIDIA XML has no bounded GPU records",
				"nvidia-smi-contexts",
			),
		);
	let contextCount = 0;
	for (const match of gpuBlocks) {
		const block = match[1] ?? "";
		const uuid = xmlText(block, "uuid");
		const physicalDevice = uuid ? byUuid.get(uuid) : undefined;
		if (!physicalDevice)
			return error(
				diag(
					"ambiguous-identity",
					"NVIDIA XML GPU cannot be mapped to a stable UUID",
					"nvidia-smi-contexts",
				),
			);
		for (const processMatch of block.matchAll(
			/<process_info>([\s\S]*?)<\/process_info>/g,
		)) {
			contextCount++;
			if (contextCount > HOST_PROBE_PARSE_LIMITS.maxRecords)
				return error(
					diag(
						"too-many-records",
						"NVIDIA XML has too many processes",
						"nvidia-smi-contexts",
					),
				);
			const process = processMatch[1] ?? "";
			const pid = parseNonNegativeInteger(xmlText(process, "pid"));
			const contextKind = nvidiaContextKind(xmlText(process, "type") ?? "");
			const used = xmlText(process, "used_memory");
			const memoryMatch = used?.match(/^(\d+)\s+MiB$/);
			const mib = memoryMatch
				? parseUnsignedBigInt(memoryMatch[1] ?? "")
				: null;
			if (!pid || !contextKind || (used !== "N/A" && mib === null))
				return error(
					diag(
						"malformed-output",
						"NVIDIA XML process record is incomplete",
						"nvidia-smi-contexts",
					),
				);
			const partitionMatches = [...byUuid.values()].filter(
				(candidate) =>
					candidate.identity.partition !== null &&
					candidate.identity.pciAddress ===
						physicalDevice.identity.pciAddress &&
					candidate.occupancy.occupants.some(
						(occupant) => occupant.pid === pid,
					),
			);
			// compute-apps carries the stable MIG UUID. Use that prior mapping and
			// never copy the same context onto both its parent and partition.
			if (
				partitionMatches.length > 1 &&
				(contextKind === "compute" || contextKind === "mps")
			)
				continue;
			const device = partitionMatches[0] ?? physicalDevice;
			addEvidence(
				device,
				pid,
				{
					kind: "compute-context",
					source: "nvidia-smi-processes",
					admission: "blocking",
					contextKind,
				},
				pidStartFor(pid, starts),
			);
			if (mib !== null && mib > 0n) {
				addEvidence(
					device,
					pid,
					{
						kind: "device-memory",
						source: "nvidia-smi-processes",
						admission: "blocking",
						residentBytes: mib * 1024n * 1024n,
						memoryKind: "framebuffer",
					},
					pidStartFor(pid, starts),
				);
			}
		}
	}
	return { status: "ok", value: null, diagnostics: [] };
}

export function parseNvidiaSmi(
	captures: NvidiaSmiCaptures,
): ProbeResult<GpuDeviceObservation[]> {
	const metricLines = boundedLines<GpuDeviceObservation[]>(
		captures.metrics,
		"nvidia-smi-metrics",
	);
	if (!metricLines.ok) return metricLines.result;
	const processLines = boundedLines<GpuDeviceObservation[]>(
		captures.processes,
		"nvidia-smi-processes",
	);
	if (!processLines.ok) return processLines.result;
	const listingLines = boundedLines<GpuDeviceObservation[]>(
		captures.listing,
		"nvidia-smi-listing",
	);
	if (!listingLines.ok) return listingLines.result;
	const listing = parseNvidiaListing(listingLines.lines);
	if (!listing)
		return error(
			diag(
				"malformed-output",
				"nvidia-smi listing is malformed",
				"nvidia-smi-listing",
			),
		);
	const metricRecordCount = metricLines.lines.filter((line) =>
		line.trim(),
	).length;
	const processRecordCount = processLines.lines.filter((line) =>
		line.trim(),
	).length;
	if (
		metricRecordCount > HOST_PROBE_PARSE_LIMITS.maxRecords ||
		processRecordCount > HOST_PROBE_PARSE_LIMITS.maxRecords
	) {
		return error(
			diag(
				"too-many-records",
				"NVIDIA output exceeds the parser record limit",
				"nvidia-smi",
			),
		);
	}
	const devices: GpuDeviceObservation[] = [];
	const byUuid = new Map<string, GpuDeviceObservation>();
	for (const line of metricLines.lines) {
		if (!line.trim()) continue;
		const fields = parseCsvLine(line);
		if (fields?.length !== 4 && fields?.length !== 7) {
			return error(
				diag(
					"malformed-output",
					"NVIDIA metric CSV row must contain four or seven fields",
					"nvidia-smi-metrics",
				),
			);
		}
		const [
			bdfField,
			uuidField,
			utilizationField,
			memoryField,
			memoryTotalField,
			temperatureField,
			powerField,
		] = fields;
		if (
			bdfField === undefined ||
			uuidField === undefined ||
			utilizationField === undefined ||
			memoryField === undefined
		) {
			return error(
				diag(
					"missing-field",
					"NVIDIA metric CSV row is incomplete",
					"nvidia-smi-metrics",
				),
			);
		}
		const bdf = canonicalizePciAddress(bdfField);
		const uuid = stableUuid(uuidField);
		const utilization =
			utilizationField === "N/A" ? null : percentFraction(utilizationField);
		const mib = memoryField === "N/A" ? null : parseUnsignedBigInt(memoryField);
		const totalMib =
			memoryTotalField === undefined || memoryTotalField === "N/A"
				? null
				: parseUnsignedBigInt(memoryTotalField);
		const temperature =
			temperatureField === undefined || temperatureField === "N/A"
				? null
				: parseFiniteNumber(temperatureField);
		const power =
			powerField === undefined || powerField === "N/A"
				? null
				: parseFiniteNumber(powerField);
		if (
			!bdf ||
			!uuid ||
			(utilizationField !== "N/A" && utilization === null) ||
			(memoryField !== "N/A" && mib === null) ||
			(memoryTotalField !== undefined &&
				memoryTotalField !== "N/A" &&
				totalMib === null) ||
			(temperatureField !== undefined &&
				temperatureField !== "N/A" &&
				temperature === null) ||
			(powerField !== undefined && powerField !== "N/A" && power === null) ||
			(power !== null && power < 0)
		) {
			return error(
				diag(
					"invalid-value",
					"NVIDIA metric CSV contains an invalid identity or value",
					"nvidia-smi-metrics",
				),
			);
		}
		const device = gpuObservation(
			{
				vendor: "nvidia",
				pciAddress: bdf,
				uuid,
				partition: null,
				displayIndex: null,
			},
			utilization,
			mib === null ? null : mib * 1024n * 1024n,
			{
				memoryTotalBytes: totalMib === null ? null : totalMib * 1024n * 1024n,
				temperatureCelsius: temperature,
				powerWatts: power,
			},
		);
		devices.push(device);
		if (byUuid.has(uuid)) {
			return error(
				diag(
					"duplicate-identity",
					"Duplicate NVIDIA UUID",
					"nvidia-smi-metrics",
				),
			);
		}
		byUuid.set(uuid, device);
	}
	if (
		devices.length === 0 ||
		devices.length > HOST_PROBE_PARSE_LIMITS.maxRecords
	) {
		return error(
			diag(
				"missing-field",
				"NVIDIA metrics contain no devices",
				"nvidia-smi-metrics",
			),
		);
	}
	if (listing.physical.size !== devices.length) {
		return error(
			diag(
				"ambiguous-identity",
				"NVIDIA listing and metrics have different device counts",
				"nvidia-smi",
			),
		);
	}
	for (const [index, uuid] of listing.physical) {
		const physical = byUuid.get(uuid);
		if (!physical) {
			return error(
				diag(
					"ambiguous-identity",
					"NVIDIA listing UUID has no matching stable metric identity",
					"nvidia-smi",
				),
			);
		}
		physical.identity.displayIndex = index;
	}
	for (const partition of listing.partitions) {
		const parentUuid = listing.physical.get(partition.parentIndex);
		const parent = parentUuid ? byUuid.get(parentUuid) : undefined;
		if (!parent)
			return error(
				diag(
					"ambiguous-identity",
					"MIG partition has no physical parent",
					"nvidia-smi-listing",
				),
			);
		const device = gpuObservation(
			{
				vendor: "nvidia",
				pciAddress: parent.identity.pciAddress,
				uuid: partition.uuid,
				partition: {
					kind: "nvidia-mig",
					id: partition.id,
					uuid: partition.uuid,
				},
				displayIndex: parent.identity.displayIndex,
			},
			null,
			null,
		);
		devices.push(device);
		if (byUuid.has(partition.uuid))
			return error(
				diag(
					"duplicate-identity",
					"Duplicate NVIDIA UUID",
					"nvidia-smi-listing",
				),
			);
		byUuid.set(partition.uuid, device);
	}
	const duplicate = validateUniqueDevices(devices);
	if (duplicate) return error(duplicate);
	for (const line of processLines.lines) {
		if (!line.trim()) continue;
		const fields = parseCsvLine(line);
		if (fields?.length !== 3) {
			return error(
				diag(
					"malformed-output",
					"NVIDIA process CSV row must contain three fields",
					"nvidia-smi-processes",
				),
			);
		}
		const [uuidField, pidField, memoryField] = fields;
		if (
			uuidField === undefined ||
			pidField === undefined ||
			memoryField === undefined
		) {
			return error(
				diag(
					"missing-field",
					"NVIDIA process CSV row is incomplete",
					"nvidia-smi-processes",
				),
			);
		}
		const device = byUuid.get(uuidField);
		const pid = parseNonNegativeInteger(pidField);
		const mib = memoryField === "N/A" ? null : parseUnsignedBigInt(memoryField);
		if (
			!device ||
			pid === null ||
			pid === 0 ||
			(memoryField !== "N/A" && mib === null)
		) {
			return error(
				diag(
					"ambiguous-identity",
					"NVIDIA process cannot be mapped safely to a stable device",
					"nvidia-smi-processes",
				),
			);
		}
		addEvidence(
			device,
			pid,
			{
				kind: "compute-context",
				source: "nvidia-smi-compute-apps",
				admission: "blocking",
				contextKind: "compute",
			},
			pidStartFor(pid, captures.pidStarts),
		);
		if (mib !== null && mib > 0n) {
			addEvidence(
				device,
				pid,
				{
					kind: "device-memory",
					source: "nvidia-smi-compute-apps",
					admission: "blocking",
					residentBytes: mib * 1024n * 1024n,
					memoryKind: "framebuffer",
				},
				pidStartFor(pid, captures.pidStarts),
			);
		}
	}
	if (captures.contexts) {
		const contexts = addNvidiaXmlContexts(
			captures.contexts,
			byUuid,
			captures.pidStarts,
		);
		if (contexts.status === "error" || contexts.status === "unsupported")
			return {
				status: contexts.status,
				value: null,
				diagnostics: contexts.diagnostics,
			};
		if (contexts.status === "degraded")
			return error(
				diag(
					"partial-observation",
					"NVIDIA context surface was incomplete",
					"nvidia-smi-contexts",
				),
			);
	}
	return { status: "ok", value: devices, diagnostics: [] };
}

/** Compile-time assertion that parser-created occupants stay on the shared contract. */
const _occupantContract: GpuOccupant | null = null;
void _occupantContract;
