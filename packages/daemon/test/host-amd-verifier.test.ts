import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseHostAmdVerifyArgs,
	verifyHostAmd,
} from "../src/verify-host-amd.ts";

const verifier = join(import.meta.dir, "..", "src", "verify-host-amd.ts");
const fixtureRoot = join(import.meta.dir, "fixtures", "host-probes", "amd");
let root: string;
let fakeBin: string;
let observerTmp: string;

beforeEach(async () => {
	root = join(tmpdir(), `mfw-amd-verifier-${crypto.randomUUID()}`);
	fakeBin = join(root, "bin");
	observerTmp = join(root, "observer-tmp");
	await mkdir(fakeBin, { recursive: true });
	await mkdir(observerTmp, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function fixture(name: string): Promise<string> {
	return readFile(join(fixtureRoot, name), "utf8");
}

async function installFakeAmdSmi(): Promise<void> {
	const [list, metrics, processes] = await Promise.all([
		fixture("list.json"),
		fixture("metrics-low-utilization.json"),
		fixture("processes-low-utilization.json"),
	]);
	const script = `#!/usr/bin/env bun
const args = Bun.argv.slice(2).join(" ");
if (process.env.MFW_FAKE_AMD_TIMEOUT === "1") await Bun.sleep(30_000);
if (args === "version") console.log("AMD SMI 25.3.0 synthetic-raw-secret");
else if (args === "list --json") console.log(${JSON.stringify(list)});
else if (args === "metric --usage --mem-usage --json") {
  console.log(process.env.MFW_FAKE_AMD_MALFORMED === "1" ? "raw-malformed-secret" : ${JSON.stringify(metrics)});
} else if (args === "process --json") console.log(${JSON.stringify(processes)});
else process.exit(9);
`;
	const path = join(fakeBin, "amd-smi");
	await writeFile(path, script, { mode: 0o700 });
	await chmod(path, 0o700);
}

async function run(input: {
	path?: string;
	timeoutSeconds?: number;
	maxOutputBytes?: number;
	env?: Record<string, string>;
}) {
	const proc = Bun.spawn(
		[
			process.execPath,
			verifier,
			"--observe-only",
			"--timeout-seconds",
			String(input.timeoutSeconds ?? 5),
			"--max-output-bytes",
			String(input.maxOutputBytes ?? 1_048_576),
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				MFW_VERIFY_HOST_AMD: "1",
				TMPDIR: observerTmp,
				PATH: input.path ?? `${fakeBin}:${process.env.PATH ?? ""}`,
				...input.env,
			},
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		stdout,
		stderr,
		exitCode,
		result: JSON.parse(stdout) as {
			status: string;
			reason?: string;
			result?: string;
			externalOccupancyObserved?: boolean;
			devices?: Array<{
				device: string;
				memoryUsedBytes: string | null;
				occupancy: { state: string; occupantCount: number };
			}>;
		},
	};
}

async function verifyWithIsolatedKfd(maxOutputBytes = 1_048_576) {
	const emptyKfd = join(root, "empty-kfd");
	const missingTopology = join(root, "missing-topology");
	await mkdir(emptyKfd, { recursive: true });
	const prior = {
		verify: process.env.MFW_VERIFY_HOST_AMD,
		tmp: process.env.TMPDIR,
		path: process.env.PATH,
	};
	process.env.MFW_VERIFY_HOST_AMD = "1";
	process.env.TMPDIR = observerTmp;
	process.env.PATH = `${fakeBin}:${prior.path ?? ""}`;
	try {
		return await verifyHostAmd(
			parseHostAmdVerifyArgs([
				"--observe-only",
				"--timeout-seconds",
				"5",
				"--max-output-bytes",
				String(maxOutputBytes),
			]),
			{ kfdProcRoots: [emptyKfd], kfdTopologyRoot: missingTopology },
		);
	} finally {
		if (prior.verify === undefined) delete process.env.MFW_VERIFY_HOST_AMD;
		else process.env.MFW_VERIFY_HOST_AMD = prior.verify;
		if (prior.tmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = prior.tmp;
		if (prior.path === undefined) delete process.env.PATH;
		else process.env.PATH = prior.path;
	}
}

describe("opt-in live AMD observer contract", () => {
	test("uses the production fixture parser, redacts identity, and accepts external occupancy", async () => {
		await installFakeAmdSmi();
		const observed = await verifyWithIsolatedKfd();
		expect(observed).toMatchObject({
			status: "observed",
			result: "external-or-unknown-occupancy-observed",
			externalOccupancyObserved: true,
			devices: [
				{
					memoryUsedBytes: "18504421376",
					occupancy: { state: "occupied", occupantCount: 1 },
				},
			],
		});
		const serialized = JSON.stringify(observed);
		const devices = observed.devices as Array<{ device: string }> | undefined;
		expect(devices?.[0]?.device).toMatch(/^[0-9a-f]{16}$/);
		expect(serialized).not.toContain("4242");
		expect(serialized).not.toContain("0000:41:00.0");
		expect(serialized).not.toContain("AMD-00000000");
		expect(serialized).not.toContain("synthetic-raw-secret");
		expect(await readdir(observerTmp)).toEqual([]);
	});

	test("only unavailable hardware/tool support skips successfully", async () => {
		const unsupported = await verifyWithIsolatedKfd();
		expect(unsupported).toMatchObject({
			status: "skipped",
			reason: "tool-missing: Required probe tool is missing",
		});
		expect(await readdir(observerTmp)).toEqual([]);
	}, 20_000);

	test("malformed output, timeouts, and capture caps fail nonzero without raw output", async () => {
		await installFakeAmdSmi();
		const malformed = await run({ env: { MFW_FAKE_AMD_MALFORMED: "1" } });
		expect(malformed.exitCode).toBe(1);
		expect(malformed.result.status).toBe("failed");
		expect(malformed.stdout).not.toContain("raw-malformed-secret");

		const timedOut = await run({
			timeoutSeconds: 1,
			env: { MFW_FAKE_AMD_TIMEOUT: "1" },
		});
		expect(timedOut.exitCode).toBe(1);
		expect(timedOut.result.status).toBe("failed");
		expect(timedOut.result.reason).toStartWith("probe-timeout:");

		const capped = await verifyWithIsolatedKfd(1_024);
		expect(capped.status).toBe("failed");
		expect(capped.reason).toBe("output-truncated: Probe output was truncated");
		expect(
			new TextEncoder().encode(JSON.stringify(capped)).byteLength,
		).toBeLessThanOrEqual(1_024);
		expect(await readdir(observerTmp)).toEqual([]);
	});
});
