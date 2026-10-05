import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import type {
	GpuDeviceObservation,
	GpuOccupancyEvidence,
	ProbeDiagnostic,
} from "@mfw/core/host-observation";
import { createProductionHostProbeRuntime } from "./host-probe-runtime.ts";
import { AmdSmiProbeAdapter } from "./host-probes.ts";
import { readKernelBootId } from "./host-resources/identity.ts";

// discover: version + two bounded five-command capture attempts; sample reuses
// the version and may perform two more attempts. Dividing the caller's budget
// by the worst-case 21 captures makes aggregate vendor command output bounded.
const MAX_AMD_COMMAND_CAPTURES = 21;
const DEFAULT_TIMEOUT_SECONDS = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

type VerifyOptions = {
	observeOnly: boolean;
	timeoutSeconds: number;
	maxOutputBytes: number;
};

function parsePositiveInteger(value: string | undefined, flag: string): number {
	if (!value || !/^[1-9][0-9]*$/.test(value)) {
		throw new Error(`${flag} requires a positive integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error(`${flag} is outside the safe range`);
	return parsed;
}

export function parseHostAmdVerifyArgs(args: readonly string[]): VerifyOptions {
	let observeOnly = false;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--observe-only") {
			observeOnly = true;
		} else if (arg === "--timeout-seconds") {
			timeoutSeconds = parsePositiveInteger(args[++index], arg);
		} else if (arg === "--max-output-bytes") {
			maxOutputBytes = parsePositiveInteger(args[++index], arg);
		} else {
			throw new Error(`unknown argument '${arg ?? ""}'`);
		}
	}
	if (!observeOnly) throw new Error("--observe-only is mandatory");
	if (timeoutSeconds > 60)
		throw new Error("--timeout-seconds must be at most 60");
	if (maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES) {
		throw new Error("--max-output-bytes must be at most 1048576");
	}
	if (maxOutputBytes < 1_024) {
		throw new Error("--max-output-bytes must be at least 1024");
	}
	return { observeOnly, timeoutSeconds, maxOutputBytes };
}

function printable(value: string, max = 200): string {
	return value
		.replace(/[^\x20-\x7e]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function reportedVersion(value: string): string {
	return (
		/(?:^|[^0-9])([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[+-][a-zA-Z0-9.-]{1,40})?)/.exec(
			value,
		)?.[1] ?? "reported-unparseable"
	);
}

function opaque(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function amdDriverVersion(): Promise<string> {
	for (const path of [
		"/sys/module/amdgpu/version",
		"/sys/module/amdgpu/srcversion",
	]) {
		try {
			const value = printable(await readFile(path, "utf8"));
			if (value) return value;
		} catch {
			// In-tree amdgpu commonly has no standalone module version.
		}
	}
	return "unreported-in-tree-driver";
}

function evidenceSummary(items: readonly GpuOccupancyEvidence[]) {
	let residentBytes = 0n;
	const kinds: Record<string, number> = {};
	for (const evidence of items) {
		kinds[evidence.kind] = (kinds[evidence.kind] ?? 0) + 1;
		if (evidence.kind === "device-memory")
			residentBytes += evidence.residentBytes ?? 0n;
	}
	return { kinds, residentBytes: residentBytes.toString() };
}

function sanitizeDevice(device: GpuDeviceObservation) {
	const attribution = { managed: 0, external: 0, unknown: 0 };
	const evidence: GpuOccupancyEvidence[] = [...device.occupancy.deviceEvidence];
	let verifiedProcessIdentities = 0;
	for (const occupant of device.occupancy.occupants) {
		attribution[occupant.attribution]++;
		if (occupant.pidStart.status === "verified") verifiedProcessIdentities++;
		evidence.push(...occupant.evidence);
	}
	return {
		device: opaque(device.identity.key),
		vendor: "amd" as const,
		partition: device.identity.partition
			? {
					kind: device.identity.partition.kind,
					id: opaque(
						device.identity.partition.uuid ?? device.identity.partition.id,
					),
				}
			: null,
		gpuUtilization: device.gpuUtilization,
		memoryUsedBytes: device.memoryUsedBytes?.toString() ?? null,
		occupancy: {
			state: device.occupancy.state,
			blocksExclusiveAdmission: device.occupancy.blocksExclusiveAdmission,
			occupantCount: device.occupancy.occupants.length,
			attribution,
			verifiedProcessIdentities,
			evidence: evidenceSummary(evidence),
		},
	};
}

function sanitizeDiagnostic(diagnostic: ProbeDiagnostic) {
	return {
		code: diagnostic.code,
		severity: diagnostic.severity,
		admissionEffect: diagnostic.admissionEffect,
		message: printable(diagnostic.message),
		field: diagnostic.field ? printable(diagnostic.field) : null,
	};
}

function preciseReason(diagnostics: readonly ProbeDiagnostic[]): string {
	const first = diagnostics[0];
	return first
		? `${first.code}: ${printable(first.message)}`
		: "amd-gpu observation returned no diagnostic";
}

function encodedLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function emit(value: unknown, maxOutputBytes: number): boolean {
	const serialized = `${JSON.stringify(value, null, 2)}\n`;
	if (new TextEncoder().encode(serialized).byteLength > maxOutputBytes) {
		const fallback = {
			status: "failed",
			reason: "sanitized verifier result exceeded --max-output-bytes",
		};
		process.stdout.write(`${JSON.stringify(fallback)}\n`);
		return false;
	}
	process.stdout.write(serialized);
	return true;
}

function unsupportedResult(diagnostics: readonly ProbeDiagnostic[]): boolean {
	const supportedCodes = new Set([
		"unsupported-platform",
		"tool-missing",
		"tool-version-unsupported",
	]);
	return (
		diagnostics.length > 0 &&
		diagnostics.every((diagnostic) => supportedCodes.has(diagnostic.code))
	);
}

export async function verifyHostAmd(
	options: VerifyOptions,
	dependencies: {
		kfdProcRoots?: readonly string[];
		kfdTopologyRoot?: string;
	} = {},
): Promise<Record<string, unknown>> {
	if (process.env.MFW_VERIFY_HOST_AMD !== "1") {
		return {
			status: "disabled",
			reason: "MFW_VERIFY_HOST_AMD=1 is required for the opt-in observer",
		};
	}
	if (platform() !== "linux") {
		return { status: "skipped", reason: `unsupported platform: ${platform()}` };
	}
	const temporaryHome = await mkdtemp(
		join(process.env.TMPDIR ?? "/tmp", "mfw-amd-observer-"),
	);
	const priorHome = process.env.MFW_HOME;
	process.env.MFW_HOME = temporaryHome;
	const timeoutMs = options.timeoutSeconds * 1_000;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const runtime = createProductionHostProbeRuntime();
		const kernelBootId = await readKernelBootId();
		const perCaptureBytes = Math.max(
			1,
			Math.floor(options.maxOutputBytes / MAX_AMD_COMMAND_CAPTURES),
		);
		const adapter = new AmdSmiProbeAdapter(
			{
				runtime,
				processBootId: randomUUID(),
				kernelBootId,
				commandTimeoutMs: timeoutMs,
				commandOutputBytes: perCaptureBytes,
			},
			"amd-smi",
			dependencies.kfdProcRoots,
			dependencies.kfdTopologyRoot,
		);
		const discovery = await adapter.discover(controller.signal);
		const base = {
			mode: "observe-only",
			mfwHome: "temporary-removed-after-observation",
			limits: {
				timeoutSeconds: options.timeoutSeconds,
				maxOutputBytes: options.maxOutputBytes,
				perCommandCaptureBytes: perCaptureBytes,
			},
			versions: {
				kernel: {
					release: printable(release()),
					architecture: printable(arch()),
				},
				vendor: { amdgpu: await amdDriverVersion() },
				tool: {
					name: printable(discovery.tool.name),
					version: reportedVersion(discovery.tool.version),
				},
				adapter: printable(discovery.adapterVersion),
			},
		};
		if (
			discovery.result.status === "unsupported" &&
			unsupportedResult(discovery.result.diagnostics)
		) {
			return {
				...base,
				status: "skipped",
				reason: preciseReason(discovery.result.diagnostics),
				diagnostics: discovery.result.diagnostics.map(sanitizeDiagnostic),
			};
		}
		if (
			discovery.result.status !== "ok" &&
			discovery.result.status !== "degraded"
		) {
			return {
				...base,
				status: "failed",
				reason: preciseReason(discovery.result.diagnostics),
				diagnostics: discovery.result.diagnostics.map(sanitizeDiagnostic),
			};
		}
		const observation = await adapter.sample(
			discovery.result.value.map((identity) => ({
				id: opaque(identity.key),
				deviceKey: identity.key,
				...(identity.partition
					? {
							partitionKey: identity.partition.uuid ?? identity.partition.id,
						}
					: {}),
			})),
			controller.signal,
		);
		if (
			observation.result.status === "unsupported" &&
			unsupportedResult(observation.result.diagnostics)
		) {
			return {
				...base,
				status: "skipped",
				reason: preciseReason(observation.result.diagnostics),
				diagnostics: observation.result.diagnostics.map(sanitizeDiagnostic),
			};
		}
		if (
			observation.result.status !== "ok" &&
			observation.result.status !== "degraded"
		) {
			return {
				...base,
				status: "failed",
				reason: preciseReason(observation.result.diagnostics),
				diagnostics: observation.result.diagnostics.map(sanitizeDiagnostic),
			};
		}
		const devices = observation.result.value.map(sanitizeDevice);
		const externalOccupancyObserved = devices.some(
			(device) =>
				device.occupancy.state !== "idle" &&
				device.occupancy.occupantCount > 0 &&
				(device.occupancy.attribution.external > 0 ||
					device.occupancy.attribution.unknown > 0),
		);
		const result = {
			...base,
			status: "observed",
			result: externalOccupancyObserved
				? "external-or-unknown-occupancy-observed"
				: "observation-complete",
			externalOccupancyObserved,
			deviceCount: devices.length,
			devices,
			diagnostics: observation.result.diagnostics.map(sanitizeDiagnostic),
		};
		if (encodedLength(result) > options.maxOutputBytes) {
			return {
				...base,
				status: "failed",
				reason: "sanitized observation exceeds --max-output-bytes",
			};
		}
		return result;
	} finally {
		clearTimeout(timeout);
		if (priorHome === undefined) delete process.env.MFW_HOME;
		else process.env.MFW_HOME = priorHome;
		await rm(temporaryHome, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
	try {
		const options = parseHostAmdVerifyArgs(Bun.argv.slice(2));
		maxOutputBytes = options.maxOutputBytes;
		const result = await verifyHostAmd(options);
		const emitted = emit(result, maxOutputBytes);
		if (!emitted || result.status === "failed") process.exitCode = 1;
	} catch (error) {
		emit(
			{
				status: "failed",
				reason: printable(
					error instanceof Error ? error.message : String(error),
				),
			},
			maxOutputBytes,
		);
		process.exitCode = 2;
	}
}

if (import.meta.main) await main();
