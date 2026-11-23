import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HarnessManifest,
	HarnessManifestSchema,
	isEgressHost,
	UNATTESTED_CONFIG_MARKER,
} from "../harness.ts";
import { buildAutonomyTable, findAutonomyFlags } from "../harness-autonomy.ts";
import {
	FLEET_WRITABLE_CEILING,
	type HarnessDetectionSpec,
	type HarnessOrigin,
	harnessCeilingViolations,
} from "../harness-registry.ts";
import type { CheckResult } from "./kit.ts";

/**
 * The harness suite of the conformance kit. A manifest is data, so this checks
 * the manifest and drives the caller's real detector against a fake binary in
 * a temporary directory. It never runs a real agent CLI.
 */

/** Bypass arguments each known harness must declare, one argv per entry. */
export const KNOWN_BYPASS_ARGV: Readonly<
	Record<string, readonly (readonly string[])[]>
> = {
	"claude-cli": [
		["--dangerously-skip-permissions"],
		["--allow-dangerously-skip-permissions"],
		["--permission-mode", "bypassPermissions"],
		["--permission-mode", "auto"],
		["--permission-mode", "acceptEdits"],
	],
	"codex-cli": [
		["--dangerously-bypass-approvals-and-sandbox"],
		["--full-auto"],
		["--yolo"],
		["--approve-for-me"],
		["--ask-for-approval", "never"],
		["-a", "never"],
		["--sandbox", "danger-full-access"],
		["-s", "danger-full-access"],
		["-c", 'approval_policy="never"'],
		["--config", 'sandbox_mode="danger-full-access"'],
	],
	"gemini-cli": [
		["--yolo"],
		["-y"],
		["--approval-mode", "yolo"],
		["--approval-mode", "auto_edit"],
	],
	"cursor-agent": [["--force"], ["-f"], ["--yolo"], ["--approve-mcps"]],
	opencode: [["--dangerously-skip-permissions"]],
	pi: [["--approve"]],
};

export interface HarnessDetectResult {
	installed: boolean;
	version: string | null;
}

export interface HarnessConformanceSubject {
	manifest: unknown;
	origin: HarnessOrigin;
	/** The real detector, given a PATH holding only the fake binary. */
	detect(
		spec: HarnessDetectionSpec,
		env: { PATH: string },
	): Promise<HarnessDetectResult>;
	/** Help output that satisfies a `help-text` identity. */
	helpText?: string;
}

const FAKE_VERSION = "9.8.7-conformance";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function fakeScript(version: string, help: string): string {
	return `#!/bin/sh
case "$1" in
--help|-h|help) printf '%s\\n' ${shellQuote(help)} ;;
*) printf '%s\\n' ${shellQuote(version)} ;;
esac
`;
}

/** A directory holding a fake `bin`, linked the way the identity expects. */
function plantFake(
	root: string,
	name: string,
	bin: string,
	linkTarget: string | null,
	help: string,
): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const script = fakeScript(FAKE_VERSION, help);
	if (linkTarget) {
		const real = join(root, `${name}-real`);
		mkdirSync(real, { recursive: true });
		const target = join(real, linkTarget);
		writeFileSync(target, script);
		chmodSync(target, 0o755);
		symlinkSync(target, join(dir, bin));
	} else {
		const path = join(dir, bin);
		writeFileSync(path, script);
		chmodSync(path, 0o755);
	}
	return dir;
}

function specOf(m: HarnessManifest): HarnessDetectionSpec {
	return {
		id: m.id,
		displayName: m.displayName,
		bin: m.detect.bin,
		versionArgs: m.detect.versionArgs,
		...(m.detect.versionRange ? { versionRange: m.detect.versionRange } : {}),
		...(m.detect.identity ? { identity: m.detect.identity } : {}),
	};
}

export async function runHarnessConformance(
	subject: HarnessConformanceSubject,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const check = async (name: string, fn: () => void | Promise<void>) => {
		try {
			await fn();
			results.push({ kind: "harness", name, status: "pass" });
		} catch (error) {
			results.push({
				kind: "harness",
				name,
				status: "fail",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const assert = (ok: unknown, message: string) => {
		if (!ok) throw new Error(message);
	};

	const parsed = HarnessManifestSchema.safeParse(subject.manifest);
	await check("the manifest passes the schema", () => {
		assert(
			parsed.success,
			parsed.success
				? ""
				: parsed.error.issues
						.map((x) => `${x.path.join(".")}: ${x.message}`)
						.join("; "),
		);
	});
	if (!parsed.success) return results;
	const m = parsed.data;

	await check("the manifest is within the ceilings", () => {
		const over = harnessCeilingViolations(m, subject.origin);
		assert(over.length === 0, over.join("; "));
	});

	const root = mkdtempSync(join(tmpdir(), "mfw-harness-conformance-"));
	try {
		const identity = m.detect.identity;
		await check(
			"detect finds a fake binary and reads its version",
			async () => {
				if (identity?.kind === "help-text")
					assert(
						subject.helpText,
						"a help-text identity needs subject.helpText",
					);
				const dir = plantFake(
					root,
					"good",
					m.detect.bin,
					identity?.kind === "symlink-target" ? identity.basename : null,
					subject.helpText ?? "fixture",
				);
				const found = await subject.detect(specOf(m), { PATH: dir });
				assert(found.installed, `${m.detect.bin} was not detected`);
				assert(
					found.version === FAKE_VERSION,
					`version read as ${found.version}`,
				);
			},
		);
		await check(
			"detect reports a missing binary as not installed",
			async () => {
				const dir = join(root, "empty");
				mkdirSync(dir, { recursive: true });
				const found = await subject.detect(specOf(m), { PATH: dir });
				assert(!found.installed, "an empty PATH counted as installed");
			},
		);
		if (identity)
			await check("detect refuses an impostor with the same name", async () => {
				const dir = plantFake(
					root,
					"impostor",
					m.detect.bin,
					null,
					"some other tool",
				);
				const found = await subject.detect(specOf(m), { PATH: dir });
				assert(!found.installed, "an impostor binary counted as installed");
			});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	await check("egress hosts are exact and unique", () => {
		const seen = new Set<string>();
		for (const e of m.egress) {
			assert(isEgressHost(e.host), `${e.host} is not an exact name`);
			const key = `${e.host}:${e.port}`;
			assert(!seen.has(key), `${key} is listed twice`);
			seen.add(key);
		}
	});

	await check("telemetry is off without the opt-in", () => {
		const hosts = m.egress.filter((e) => e.purpose === "telemetry");
		for (const e of hosts)
			assert(!e.requiresApiKey, `${e.host}: telemetry tied to an API key`);
	});

	await check("the autonomy list covers the known bypass flags", () => {
		const own = buildAutonomyTable([]);
		const declared = {
			flags: new Set(m.autonomy.flags),
			values: new Set(m.autonomy.values.map((v) => `${v.option}\0${v.value}`)),
			config: new Set(m.autonomy.config.map((c) => `${c.key}\0${c.value}`)),
		};
		for (const argv of KNOWN_BYPASS_ARGV[m.id] ?? []) {
			assert(
				findAutonomyFlags(own, argv).length > 0,
				`the gate does not recognise ${argv.join(" ")}`,
			);
			const [first, second] = argv as [string, string | undefined];
			const covered =
				second === undefined
					? declared.flags.has(first)
					: m.autonomy.configOptions.includes(first)
						? declared.config.has(
								`${second.slice(0, second.indexOf("="))}\0${second
									.slice(second.indexOf("=") + 1)
									.replace(/^["']|["']$/g, "")}`,
							)
						: declared.values.has(`${first}\0${second}`);
			assert(covered, `${m.id} does not declare ${argv.join(" ")}`);
		}
	});

	await check("fleet dirs are within the ceiling and marked", () => {
		for (const dir of m.fleet.writable)
			assert(FLEET_WRITABLE_CEILING.has(dir), `${dir} is over the ceiling`);
		if (m.fleet.writable.length > 0)
			assert(
				m.fleet.attestation === UNATTESTED_CONFIG_MARKER,
				`a temporary allowlist must carry ${UNATTESTED_CONFIG_MARKER}`,
			);
		if (m.fleet.transcriptDir)
			assert(
				m.fleet.writable.includes(m.fleet.transcriptDir),
				"the transcript dir must be writable",
			);
	});

	return results;
}
