import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	configPath,
	mutateConfig,
	parseConfigText,
	type StoredProjectConfig,
} from "../config.ts";
import { gitRaw } from "../git.ts";
import { repoConfigRefusal } from "../host-git/repo-config.ts";
import { validateRefName } from "../repo-view.ts";
import {
	acquireDaemonLock,
	DaemonLockError,
} from "../resources/daemon-lock.ts";
import { liveDoctorProbes } from "./live-probes.ts";
import type { DoctorProbes } from "./probes.ts";
import {
	type DoctorReport,
	doctorExitCode,
	redactReport,
	redactText,
	renderDoctorReport,
	sanitizeText,
} from "./report.ts";
import { isPublicForgeUrl, redactContextFor, runDoctor } from "./run.ts";

/**
 * `mfw doctor` and `mfw init`.
 *
 * Inside an agent sandbox both refuse (exit 3), as `mfw auth` does. A report
 * from there would describe the sandbox's masked view as if it were the host.
 * The environment markers are a courtesy: an agent can unset them. What keeps
 * the owner's state from an agent is that `$MFW_HOME` is hidden in the sandbox.
 */

export const DOCTOR_USAGE = [
	"usage: mfw doctor [--json] [--redact|--no-redact] [--redact-projects] [--harness-versions] [--first-run]",
	"",
	"  Read-only host and install check. It prints fixes and never applies them.",
	"  --json             the report as JSON (schemaVersion 1), redacted by default",
	"  --redact           safe to paste: no home paths, user name, URL paths, file names or tokens",
	"  --no-redact        keep local detail in --json",
	"  --redact-projects  also hide project names",
	"  --harness-versions  also run each installed agent CLI's version command",
	"  --first-run        the guided first-run flow (same as mfw init)",
	"",
	"  exit: 0 no blockers, 1 a blocker exists, 2 usage, 3 refused in a sandbox",
].join("\n");

export const INIT_USAGE = [
	"usage: mfw init [--project <dir>] [--name <name>] [--branch <branch>] [--write] [--json] [--no-redact] [--harness-versions]",
	"",
	"  Runs the doctor, shows where the setup token is and what to do next.",
	"  With --project it prints a minimal project entry. Only --write adds it",
	"  to $MFW_HOME/config.json, and that is refused while the server runs.",
].join("\n");

export interface DoctorCliDeps {
	env: Record<string, string | undefined>;
	home: string;
	out: (line: string) => void;
	err: (line: string) => void;
	exposure?: DoctorProbes["exposure"];
	/** Test seam: the probes to use instead of the live ones. */
	probes?: DoctorProbes;
}

const SANDBOX_MARKERS = [
	"MFW_RUN_ID",
	"MFW_TASK_ID",
	"MFW_RUN_KIND",
	"MFW_AGENT_BRIDGED",
] as const;

/** The marker that says this process belongs to an agent run, if any. */
export function sandboxMarker(
	env: Record<string, string | undefined>,
): string | null {
	return SANDBOX_MARKERS.find((k) => !!env[k]) ?? null;
}

function refuseInSandbox(what: string, d: DoctorCliDeps): number | null {
	const marker = sandboxMarker(d.env);
	if (!marker) return null;
	d.err(
		`mfw ${what}: refused inside an agent run (${marker} is set). Run it on the host, outside any agent sandbox.`,
	);
	return 3;
}

const probesFor = (d: DoctorCliDeps): DoctorProbes =>
	d.probes ??
	liveDoctorProbes({
		env: d.env,
		home: d.home,
		...(d.exposure ? { exposure: d.exposure } : {}),
	});

export async function runDoctorCommand(
	args: readonly string[],
	d: DoctorCliDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		d.out(DOCTOR_USAGE);
		return 0;
	}
	if (args.includes("--first-run")) {
		return runInitCommand(
			args.filter((a) => a !== "--first-run"),
			d,
		);
	}
	const known = new Set([
		"--json",
		"--harness-versions",
		"--redact",
		"--no-redact",
		"--redact-projects",
	]);
	const bad = args.find((a) => !known.has(a));
	if (bad) {
		d.err(`mfw doctor: unknown option '${bad}'\n${DOCTOR_USAGE}`);
		return 2;
	}
	const refused = refuseInSandbox("doctor", d);
	if (refused !== null) return refused;
	if (
		args.includes("--no-redact") &&
		(args.includes("--redact") || args.includes("--redact-projects"))
	) {
		d.err(`mfw doctor: --no-redact conflicts with redaction\n${DOCTOR_USAGE}`);
		return 2;
	}
	const redacting =
		args.includes("--redact") ||
		args.includes("--redact-projects") ||
		(args.includes("--json") && !args.includes("--no-redact"));
	const probes = probesFor(d);
	const full = await runDoctor(probes, {
		harnessVersions: args.includes("--harness-versions"),
		omitFileNames: redacting,
	});
	const report = redacting
		? redactReport(
				full,
				await redactContextFor(probes, args.includes("--redact-projects")),
			)
		: full;
	d.out(
		args.includes("--json")
			? JSON.stringify(report, null, 2)
			: renderDoctorReport(report),
	);
	return doctorExitCode(report);
}

interface InitArgs {
	project?: string;
	name?: string;
	branch?: string;
	write: boolean;
	json: boolean;
	noRedact: boolean;
	harnessVersions: boolean;
}

function parseInit(args: readonly string[]): InitArgs | string {
	const out: InitArgs = {
		write: false,
		json: false,
		noRedact: false,
		harnessVersions: false,
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--write") out.write = true;
		else if (a === "--json") out.json = true;
		else if (a === "--no-redact") out.noRedact = true;
		else if (a === "--harness-versions") out.harnessVersions = true;
		else if (a === "--project" || a === "--name" || a === "--branch") {
			const value = args[++i];
			if (value === undefined || (a !== "--name" && value.startsWith("--"))) {
				return `${a} needs a value`;
			}
			if (a === "--project") out.project = value;
			else if (a === "--name") out.name = value;
			else out.branch = value;
		} else return `unknown option '${a}'`;
	}
	if (out.write && !out.project) return "--write needs --project";
	return out;
}

/** The smallest entry whose runs can start: the defaults are a private clone in the sandbox. */
export function minimalProjectEntry(input: {
	name: string;
	root: string;
	branch: string;
}): StoredProjectConfig {
	return {
		name: input.name,
		root: input.root,
		integrationBranch: input.branch,
	};
}

async function currentBranch(root: string): Promise<string | null> {
	const r = await gitRaw(
		["--no-optional-locks", "symbolic-ref", "--short", "HEAD"],
		root,
		{ timeoutMs: 3_000 },
	).catch(() => null);
	return r?.ok ? r.stdout.trim() || null : null;
}

/** Says the server is running only when another process really holds the lock. */
export function lockRefusal(e: unknown): string {
	return e instanceof DaemonLockError && e.busy
		? "the server is running. Stop it, or add the project in the web UI"
		: `could not take the server lock: ${(e as Error).message}`;
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const realOrSelf = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};

const isWithin = (path: string, root: string) =>
	path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** Why this resolved root cannot be a project of this home, or null. */
async function projectRootProblem(
	root: string,
	home: string,
): Promise<string | null> {
	if (!existsSync(join(root, ".git"))) return `${root} is not a git repository`;
	const realHome = realOrSelf(home);
	if (isWithin(realHome, root)) {
		return `${root} contains $MFW_HOME, and agents would be able to write to it. Choose another project root or MFW_HOME`;
	}
	if (isWithin(root, realHome)) {
		return `${root} is inside $MFW_HOME, which holds this install's secrets. Move the project out`;
	}
	// Before the branch, so a refused config is named and --branch cannot skip it.
	const refused = await repoConfigRefusal(root).catch(
		(e: unknown) =>
			({
				message: `could not audit its git config: ${(e as Error).message}`,
			}) as {
				message: string;
			},
	);
	return refused?.message ?? null;
}

/** Why saving over the current config would lose or redirect something. */
async function configSaveProblem(home: string): Promise<string | null> {
	const path = configPath(home);
	const st = await lstat(path).catch(() => null);
	if (!st) return null;
	if (st.isSymbolicLink()) {
		return "config.json is a symbolic link, and a save would replace the link. Add the entry to the file it points to yourself";
	}
	if (!st.isFile()) return "config.json is not a regular file";
	try {
		parseConfigText(await readFile(path, "utf8"));
	} catch (e) {
		return `config.json is not valid (${(e as Error).message}). Correct it first`;
	}
	return null;
}

async function writeEntry(
	home: string,
	entry: StoredProjectConfig,
): Promise<string | null> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	let lock: Awaited<ReturnType<typeof acquireDaemonLock>>;
	try {
		// The running server rewrites this file from its own copy.
		lock = await acquireDaemonLock(home, {
			processBootId: `init-${process.pid}`,
			timeoutMs: 500,
		});
	} catch (e) {
		return lockRefusal(e);
	}
	try {
		const unsafe = await configSaveProblem(home);
		if (unsafe) return unsafe;
		return await mutateConfig(home, (config) => {
			const clash = config.projects.find(
				(p) => p.name === entry.name || realOrSelf(p.root) === entry.root,
			);
			if (clash) {
				throw new InitRefused(
					`project '${clash.name}' already uses that name or root`,
				);
			}
			config.projects.push(entry);
			return null;
		});
	} catch (e) {
		if (e instanceof InitRefused) return e.message;
		throw e;
	} finally {
		await lock.release();
	}
}

class InitRefused extends Error {}

function nextSteps(report: DoctorReport, tokenPath: string): string[] {
	const auth = report.checks.find((c) => c.id === "auth.state");
	const steps: string[] = [];
	if (!report.ok) steps.push("Fix each BLOCKER above, then run: mfw doctor");
	if (auth?.status === "problem") {
		steps.push("Start the server: mfw server");
		steps.push(
			`Open the web UI and enter the one-time setup token. It is in ${tokenPath} (or print a new one with: mfw auth setup-token)`,
		);
	}
	steps.push(
		"Add a project: mfw init --project <dir> --write, or use the web UI",
	);
	steps.push("Check the result: mfw doctor");
	return steps;
}

export async function runInitCommand(
	args: readonly string[],
	d: DoctorCliDeps,
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		d.out(INIT_USAGE);
		return 0;
	}
	const parsed = parseInit(args);
	if (typeof parsed === "string") {
		d.err(`mfw init: ${parsed}\n${INIT_USAGE}`);
		return 2;
	}
	const refused = refuseInSandbox("init", d);
	if (refused !== null) return refused;

	const probes = probesFor(d);
	const redacting = parsed.json && !parsed.noRedact;
	const report = await runDoctor(probes, {
		harnessVersions: parsed.harnessVersions,
		omitFileNames: redacting,
	});
	// The path only. The token itself is never opened here.
	const tokenPath = join(d.home, "setup-token");

	let entry: StoredProjectConfig | null = null;
	let wrote = false;
	const notes: string[] = [];
	if (parsed.project) {
		const root = realOrSelf(parsed.project);
		const rootProblem = await projectRootProblem(root, d.home);
		if (rootProblem) {
			d.err(`mfw init: ${sanitizeText(rootProblem)}`);
			return 1;
		}
		const name = parsed.name ?? basename(root);
		if (!PROJECT_NAME.test(name)) {
			d.err(
				"mfw init: a project name is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit. Pass --name <name>.",
			);
			return 2;
		}
		const branch = parsed.branch ?? (await currentBranch(root));
		if (!branch) {
			d.err(
				"mfw init: cannot tell the integration branch (detached HEAD?). Pass --branch <branch>.",
			);
			return 1;
		}
		try {
			validateRefName(branch);
		} catch (e) {
			d.err(`mfw init: invalid branch: ${sanitizeText((e as Error).message)}`);
			return 2;
		}
		entry = minimalProjectEntry({ name, root, branch });
		const facts = await probes.project(entry);
		if (facts.devEnv?.state === "refused") {
			notes.push(
				`It declares a dev environment, and runs are refused until you approve it: ${facts.devEnv.fix ?? `mfw env allow ${name}`}`,
			);
		}
		if (facts.remotes.length > 0) {
			notes.push(
				'It has a remote. Pushes stay refused until you add "pushUrl" to this entry yourself.',
			);
		}
		if (facts.remotes.some((r) => isPublicForgeUrl(r.url))) {
			notes.push(
				'The remote is on a public forge. Choose "untracked" for board reports when you attach the board.',
			);
		}
		if (parsed.write) {
			const why = await writeEntry(d.home, entry);
			if (why) {
				d.err(`mfw init: not written: ${sanitizeText(why)}`);
				return 1;
			}
			wrote = true;
		}
	}

	const steps = nextSteps(report, tokenPath);
	if (parsed.json) {
		const ctx = redacting ? await redactContextFor(probes) : null;
		const shown = (text: string) => (ctx ? redactText(text, ctx) : text);
		d.out(
			JSON.stringify(
				{
					schemaVersion: 1,
					doctor: ctx ? redactReport(report, ctx) : report,
					setupTokenPath: shown(tokenPath),
					steps: steps.map(shown),
					projectEntry: entry && { ...entry, root: shown(entry.root) },
					notes,
					wrote,
				},
				null,
				2,
			),
		);
		return doctorExitCode(report);
	}
	d.out(renderDoctorReport(report));
	d.out("");
	d.out(`Setup token file: ${sanitizeText(tokenPath)}`);
	if (entry) {
		d.out("");
		d.out(
			wrote
				? "Added to $MFW_HOME/config.json (restart the server to load it):"
				: 'Minimal project entry (not written; add --write, or paste it into "projects" in $MFW_HOME/config.json):',
		);
		d.out(JSON.stringify(entry, null, 2));
		for (const note of notes) d.out(`note: ${note}`);
	}
	d.out("");
	d.out("Next steps:");
	steps.forEach((s, i) => {
		d.out(`  ${i + 1}. ${sanitizeText(s)}`);
	});
	return doctorExitCode(report);
}
