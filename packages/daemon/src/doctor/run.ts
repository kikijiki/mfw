import { join } from "node:path";
import {
	isolationConfigProblem,
	isolationDispatchProblem,
	type StoredProjectConfig,
} from "../config.ts";
import { HARNESS_EGRESS } from "../containment/egress-allowlists.ts";
import {
	BWRAP_BIND_FD_MIN_VERSION,
	bwrapSupportsBindFd,
	type Check,
	detectArch,
	detectBwrap,
	detectLinger,
	detectPersistence,
	detectSystemdUser,
	detectTiocsti,
	detectUserns,
} from "../containment/host-caps.ts";
import { assertSeccompSupported } from "../containment/seccomp.ts";
import {
	assertSocketPathFits,
	SocketPathError,
	socketRoot,
} from "../containment/socket-root.ts";
import { commandFor, isSystemPath } from "./fix-text.ts";
import type { DoctorProbes, ProjectFacts } from "./probes.ts";
import {
	buildReport,
	type DoctorCheck,
	type DoctorGroup,
	type DoctorReport,
	sanitizeText,
} from "./report.ts";

/**
 * `mfw doctor`: reports, never repairs. A fix is text for the owner to run. A
 * check that cannot finish is a blocker, because an unknown is not a pass.
 */

export interface DoctorOptions {
	/** Opt-in: run `--version` of agent CLIs found on a trusted path. */
	harnessVersions?: boolean;
}

type Outcome = Pick<DoctorCheck, "severity" | "status" | "detail"> & {
	fix?: string;
};

const ok = (detail: string): Outcome => ({
	severity: "info",
	status: "ok",
	detail,
});
const skipped = (detail: string): Outcome => ({
	severity: "info",
	status: "skipped",
	detail,
});
const problem = (
	severity: DoctorCheck["severity"],
	detail: string,
	fix?: string,
): Outcome => ({
	severity,
	status: "problem",
	detail,
	...(fix ? { fix } : {}),
});

/** A failing HCAP check, at the severity its contract gives it. */
function fromHostCheck<T>(c: Check<T>): Outcome {
	if (c.ok) return ok(c.detail);
	return problem(
		c.severity === "required" ? "blocker" : "warn",
		c.detail,
		c.fix,
	);
}

async function guarded(
	id: string,
	group: DoctorGroup,
	run: () => Outcome | Promise<Outcome>,
	project?: string,
): Promise<DoctorCheck> {
	let outcome: Outcome;
	try {
		outcome = await run();
	} catch (e) {
		outcome = problem(
			"blocker",
			`the check could not finish: ${e instanceof Error ? e.message : String(e)}`,
			"fix the cause above and run mfw doctor again",
		);
	}
	return {
		id,
		group,
		severity: outcome.severity,
		status: outcome.status,
		detail: sanitizeText(outcome.detail),
		...(outcome.fix ? { fix: sanitizeText(outcome.fix) } : {}),
		...(project ? { project: sanitizeText(project) } : {}),
	};
}

// ------------------------------------------------------------------- host

async function bwrapCheck(p: DoctorProbes): Promise<Outcome> {
	const found = await p.tool("bwrap");
	const c = await detectBwrap(p.host, found.path ?? "bwrap");
	if (!found.path || !c.ok) {
		return found.path
			? fromHostCheck(c)
			: problem(
					"blocker",
					found.untrustedPath
						? `bwrap is only at ${found.untrustedPath}, a directory an agent can write, so it was not run`
						: "bwrap was not found",
					c.fix ??
						`install bubblewrap ${BWRAP_BIND_FD_MIN_VERSION} or newer in a system or nix profile directory`,
				);
	}
	if (!bwrapSupportsBindFd(c.value)) {
		return problem(
			"blocker",
			`bwrap ${c.value.version ?? "(unknown version)"} lacks --bind-fd`,
			`upgrade bubblewrap to ${BWRAP_BIND_FD_MIN_VERSION} or newer`,
		);
	}
	return ok(c.detail);
}

function seccompCheck(p: DoctorProbes): Outcome {
	const arch = detectArch(p.host);
	try {
		assertSeccompSupported(arch.value === "x86_64" ? "x64" : p.host.arch);
		return ok("seccomp filter available (x86_64)");
	} catch (e) {
		return problem(
			"blocker",
			(e as Error).message,
			"run autonomous agents on an x86_64 host",
		);
	}
}

async function cgroupCheck(p: DoctorProbes): Promise<Outcome> {
	const raw = await p.host.readFile("/sys/fs/cgroup/cgroup.controllers");
	if (raw === undefined) {
		return problem(
			"blocker",
			"cgroup v2 is not mounted, so run limits cannot apply",
			"boot with the unified hierarchy (systemd.unified_cgroup_hierarchy=1 on the kernel command line)",
		);
	}
	return ok(`cgroup v2: ${raw.trim() || "no controllers listed"}`);
}

// ------------------------------------------------------------------ tools

async function toolCheck(
	p: DoctorProbes,
	name: string,
	flag: string,
	missing: Outcome,
): Promise<Outcome> {
	const found = await p.tool(name);
	if (!found.path) {
		return found.untrustedPath
			? {
					...missing,
					detail: `${name} is only at ${found.untrustedPath}, a directory an agent can write, so it was not run`,
				}
			: missing;
	}
	const version = await p.toolVersion(found.path, flag);
	return ok(`${name} ${version ?? "(version not readable)"}`);
}

// ---------------------------------------------------------------- storage

const NON_PERSISTENT_ROOTS = ["/tmp", "/var/tmp", "/dev/shm", "/run"];

/** Not a system tree, and holding a file only an mfw home has. */
async function isRecognisableHome(p: DoctorProbes): Promise<boolean> {
	if (isSystemPath(p.home)) return false;
	for (const marker of ["auth.db", "daemon.lock"]) {
		if ((await p.stat(join(p.home, marker)))?.kind === "file") return true;
	}
	return false;
}

async function homeCheck(p: DoctorProbes): Promise<Outcome> {
	const moved = `point MFW_HOME at a persistent directory (MFW_HOME=$HOME/.local/share/mfw)`;
	if (
		NON_PERSISTENT_ROOTS.some((r) => p.home === r || p.home.startsWith(`${r}/`))
	) {
		return problem(
			"blocker",
			`$MFW_HOME (${p.home}) is under temporary storage and is lost at reboot`,
			moved,
		);
	}
	const st = await p.stat(p.home);
	if (!st) return ok(`$MFW_HOME (${p.home}) will be created at first start`);
	// Changing the owner or mode of a tree that is not an mfw home could damage
	// the system, so those get advice to move instead of a command.
	const ours = await isRecognisableHome(p);
	const newHome =
		"this does not look like an mfw home, so do not change it: choose a new MFW_HOME (MFW_HOME=$HOME/.local/share/mfw)";
	if (st.kind !== "dir") {
		return problem(
			"blocker",
			`$MFW_HOME (${p.home}) is not a directory`,
			moved,
		);
	}
	if (st.uid !== p.uid) {
		return problem(
			"blocker",
			`$MFW_HOME (${p.home}) belongs to uid ${st.uid}, not ${p.uid}`,
			ours
				? commandFor(
						[p.home],
						(q) => `sudo chown -hR --preserve-root -- ${p.uid} ${q}`,
					)
				: newHome,
		);
	}
	const mode = (st.mode & 0o777).toString(8);
	if (st.mode & 0o022) {
		return problem(
			"blocker",
			`$MFW_HOME is writable by others (mode ${mode})`,
			ours ? commandFor([p.home], (q) => `chmod 700 -- ${q}`) : newHome,
		);
	}
	if (st.mode & 0o077) {
		return problem(
			"warn",
			`$MFW_HOME is readable by others (mode ${mode})`,
			ours ? commandFor([p.home], (q) => `chmod 700 -- ${q}`) : newHome,
		);
	}
	return ok(`$MFW_HOME (${p.home}) is private`);
}

function socketCheck(p: DoctorProbes): Outcome {
	try {
		const root = socketRoot(p.home, { env: p.env, uid: p.uid });
		// The longest socket the daemon binds below its per-home directory.
		assertSocketPathFits(join(root, "b", "0".repeat(12), "brain.sock"));
		return ok(`socket directory ${root} fits the 107-byte limit`);
	} catch (e) {
		if (e instanceof SocketPathError) {
			return problem("blocker", e.message, e.fix);
		}
		throw e;
	}
}

// ------------------------------------------------------------------- auth

async function authStateCheck(p: DoctorProbes): Promise<Outcome> {
	const a = await p.auth();
	if (a.state === "absent") {
		return problem(
			"warn",
			"no auth store yet: the server has not been started",
			"mfw server",
		);
	}
	if (a.state === "unreadable") {
		return problem(
			"warn",
			`the auth store could not be read: ${a.reason}`,
			"start the server once so it can recover the store, then run mfw doctor again",
		);
	}
	const tokens = `${a.liveTokens} live API token${a.liveTokens === 1 ? "" : "s"}`;
	if (!a.owner) {
		return problem(
			"warn",
			`first-run setup is not done (${tokens})`,
			"mfw auth setup-token",
		);
	}
	if (!a.passwordSet) {
		return problem(
			"warn",
			`the owner has no password (${tokens})`,
			"mfw auth reset --yes (this removes the owner and every session, then repeat first-run setup)",
		);
	}
	return ok(`owner set, password set, ${tokens}`);
}

async function authFilesCheck(p: DoctorProbes): Promise<Outcome> {
	const names = [
		"auth.db",
		"auth.db-wal",
		"auth.db-shm",
		"setup-token",
		"mcp-token",
	];
	const open: string[] = [];
	for (const name of names) {
		const path = join(p.home, name);
		// Metadata only: these files hold secrets and are never opened here.
		const st = await p.stat(path);
		if (st?.kind === "file" && st.mode & 0o077) open.push(path);
	}
	if (open.length > 0) {
		return problem(
			"blocker",
			`readable by other users: ${open.join(", ")}`,
			commandFor(open, (q) => `chmod 600 -- ${q}`),
		);
	}
	return ok("secret files are private");
}

// ---------------------------------------------------------------- install

async function buildCheck(p: DoctorProbes): Promise<Outcome> {
	const b = await p.build();
	if (b.kind === "source") return ok("running from source, no build to verify");
	const why = [b.hostScripts, b.migrations].filter(Boolean).join("; ");
	return why
		? problem("blocker", why, "bun run build, then restart the server")
		: ok("host script and migration manifests verify");
}

async function legacyCheck(p: DoctorProbes): Promise<Outcome> {
	const l = await p.legacyHost();
	if (l.state === "none") return ok("no legacy host.db state");
	if (l.state === "unreadable") {
		return problem("warn", `host.db could not be read: ${l.reason}`);
	}
	const list = Object.entries(l.rows)
		.map(([t, n]) => `${t} (${n})`)
		.join(", ");
	return l.state === "acknowledged"
		? ok(`legacy host.db rows acknowledged: ${list}`)
		: problem(
				"blocker",
				`host.db holds unacknowledged rows, and the server will refuse to start: ${list}`,
				"drain all runs, back up $MFW_HOME, then: mfw host acknowledge-legacy --yes",
			);
}

async function skillsCheck(
	p: DoctorProbes,
	roots: readonly string[],
): Promise<Outcome> {
	const s = await p.legacySkills(roots);
	if (!s.available) return skipped("no stale-skill detector in this build");
	if (s.paths.length === 0) return ok("no old-name skill copies");
	return problem(
		"warn",
		`old-name skill copies: ${s.paths.join(", ")}`,
		commandFor(s.paths, (q) => `remove them after checking: rm -- ${q}`),
	);
}

function exposureCheck(p: DoctorProbes): Outcome {
	if (!p.exposure) return skipped("the exposure policy is not available here");
	const { problem: refusal, warnings } = p.exposure(p.env);
	if (refusal) {
		const at = refusal.indexOf(" Fix: ");
		return at >= 0
			? problem("blocker", refusal.slice(0, at), refusal.slice(at + 6))
			: problem("blocker", refusal, "see docs/exposure.md");
	}
	if (warnings.length > 0) {
		return problem(
			"warn",
			warnings.join(" "),
			"use MFW_LISTEN_SOCKET instead (docs/exposure.md)",
		);
	}
	return ok("bind address, TLS or proxy, and allowed hosts are consistent");
}

// ---------------------------------------------------------------- harness

async function harnessChecks(
	p: DoctorProbes,
	opts: DoctorOptions,
): Promise<DoctorCheck[]> {
	const names = ["claude", "codex"] as const;
	const found = await Promise.all(names.map((n) => p.tool(n)));
	const none = found.every((f) => !f.path && !f.untrustedPath);
	return Promise.all(
		names.map((n, i) =>
			guarded(`harness.${n}`, "harness", async () => {
				const f = found[i];
				if (f?.path) {
					if (!opts.harnessVersions) {
						return ok(
							`${n} is installed (not run; --harness-versions reads its version)`,
						);
					}
					// Only `--version`: no model call, no home directory.
					const v = await p.toolVersion(f.path, "--version");
					return ok(`${n} ${v ?? "(version not readable)"}`);
				}
				if (f?.untrustedPath) {
					return problem(
						"warn",
						`${n} is at ${f.untrustedPath}, a directory an agent can write, so it was not run`,
						`install ${n} in a system or nix profile directory on PATH`,
					);
				}
				return problem(
					none ? "warn" : "info",
					`${n} is not installed`,
					`install the ${n} CLI to run agents with it`,
				);
			}),
		),
	);
}

// ----------------------------------------------------------------- egress

function allowlistCheck(): Outcome {
	const bad: string[] = [];
	for (const [harness, spec] of Object.entries(HARNESS_EGRESS)) {
		for (const e of spec.entries) {
			if (!/^[a-z0-9.-]+$/.test(e.host) || e.port !== 443) {
				bad.push(`${harness}: ${e.host}:${e.port}`);
			}
		}
	}
	return bad.length > 0
		? problem(
				"blocker",
				`egress entries are not exact host:443: ${bad.join(", ")}`,
				"reinstall mfw: the built-in allowlist was changed",
			)
		: ok("egress allowlists are exact host:443 entries");
}

// --------------------------------------------------------------- projects

const PUBLIC_FORGES = new Set([
	"github.com",
	"gitlab.com",
	"codeberg.org",
	"bitbucket.org",
	"git.sr.ht",
]);

/** The host of an https, ssh or scp-style git URL. */
export function remoteHost(url: string): string | null {
	const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(url);
	if (full) return (full[1] as string).toLowerCase();
	const scp = /^(?:[^/@]+@)?([^/:]+):/.exec(url);
	return scp ? (scp[1] as string).toLowerCase() : null;
}

/** On a public forge. It says nothing about this repository's own visibility. */
export function isPublicForgeUrl(url: string): boolean {
	const host = remoteHost(url);
	return host !== null && PUBLIC_FORGES.has(host);
}

function pushCheck(entry: StoredProjectConfig, f: ProjectFacts): Outcome {
	if (f.remotes.length === 0) return ok("no remote");
	if (entry.pushOnMerge === false) return ok("pushing is off");
	if (entry.pushUrl) return ok("pushUrl is set");
	return problem(
		"warn",
		"the project has a remote but no pushUrl, so pushes after a merge are refused",
		'set "pushOnMerge": false to keep merges local, or verify where this project should publish and add "pushUrl": "<that exact URL>" to its entry in $MFW_HOME/config.json. A remote in the repository\'s own config is not proof of the destination',
	);
}

function triggersCheck(f: ProjectFacts): Outcome {
	const t = f.triggers;
	if (t.error) {
		return problem(
			"blocker",
			`the trigger arming store is unreadable: ${t.error}`,
			"restore the file from a backup, or remove it and arm the triggers again",
		);
	}
	const notes = [
		t.drifted.length ? `changed since arming: ${t.drifted.join(", ")}` : "",
		t.quarantined.length ? `invalid: ${t.quarantined.join(", ")}` : "",
	].filter(Boolean);
	if (notes.length > 0) {
		return problem(
			"warn",
			notes.join("; "),
			"review each trigger in the web UI and arm it again",
		);
	}
	return ok(`${t.armedCurrent} armed and current, ${t.unarmed} not armed`);
}

function projectEgressCheck(entry: StoredProjectConfig): Outcome {
	const b = entry.agentEgressUploadBudget;
	if (
		b?.perDestinationBytes !== undefined &&
		b.totalBytes !== undefined &&
		b.perDestinationBytes > b.totalBytes
	) {
		return problem(
			"warn",
			"agentEgressUploadBudget.perDestinationBytes is above totalBytes, so only the total applies",
			"set perDestinationBytes to at most totalBytes",
		);
	}
	if (entry.agentIsolation === "none") {
		return problem(
			"warn",
			"unsandboxed runs have no egress proxy and use the host network",
			'set "agentIsolation": "bwrap"',
		);
	}
	if (entry.agentEgressTelemetry) {
		return problem(
			"info",
			"runs may reach their CLI's telemetry hosts",
			'set "agentEgressTelemetry": false',
		);
	}
	return ok("egress settings are consistent");
}

function untrackedCheck(f: ProjectFacts): Outcome {
	const pub = f.remotes.filter((r) => isPublicForgeUrl(r.url));
	if (pub.length === 0) return skipped("no remote on a public forge");
	if (!f.untracked || !f.ignoredState) {
		return problem("warn", "git could not list the untracked files");
	}
	const u = f.untracked;
	const s = f.ignoredState;
	if (u.count === 0 && s.count === 0) {
		return ok("nothing untracked on a public-forge project");
	}
	const count = (l: typeof u) => `${l.count}${l.truncated ? "+" : ""}`;
	const names = (l: typeof u) =>
		l.sample.length ? ` (${l.sample.join(", ")})` : "";
	const reports =
		f.boardPush === "with-code"
			? " Board reports are also pushed with the code."
			: "";
	return problem(
		"warn",
		`${count(u)} untracked file(s)${names(u)} a broad git add would publish, and ${count(s)} ignored .mfw file(s)${names(s)} no clone or push carries. The remote is on a public forge; its visibility was not checked.${reports}`,
		"add what must stay private to .gitignore and back up what must survive; review with: git ls-files --others --exclude-standard",
	);
}

async function projectChecks(
	p: DoctorProbes,
	entry: StoredProjectConfig,
): Promise<DoctorCheck[]> {
	let facts: ProjectFacts;
	try {
		facts = await p.project(entry);
	} catch (e) {
		const failed = await guarded(
			"project.root",
			"project",
			() => {
				throw e;
			},
			entry.name,
		);
		return [failed];
	}
	const at = (id: string, run: () => Outcome) =>
		guarded(`project.${id}`, "project", run, entry.name);
	return Promise.all([
		at("root", () => {
			if (!facts.rootExists) {
				return problem(
					"blocker",
					`the project root ${entry.root} does not exist`,
					"restore it, or remove this project from $MFW_HOME/config.json",
				);
			}
			if (!facts.isGit) {
				return problem(
					"blocker",
					`${entry.root} is not a git repository`,
					"restore its .git directory from a backup, or remove this project from $MFW_HOME/config.json",
				);
			}
			return ok(`${entry.root} is a git repository`);
		}),
		at("isolation", () => {
			const why = isolationConfigProblem(entry);
			if (why) {
				return problem(
					"blocker",
					why,
					'set "agentIsolation": "bwrap" (the default) in this project, or "approvalMode": "interactive"',
				);
			}
			return ok(`agent isolation: ${entry.agentIsolation ?? "bwrap"}`);
		}),
		at("dispatch", () => {
			const issue = isolationDispatchProblem({
				...entry,
				hasDevShell: facts.hasEnvrc,
			});
			return issue
				? problem("blocker", issue.detail, issue.fix)
				: ok(`run workspace: ${entry.runWorkspace ?? "worktree"}`);
		}),
		at("push", () => pushCheck(entry, facts)),
		at("triggers", () => triggersCheck(facts)),
		at("egress", () => projectEgressCheck(entry)),
		at("untracked", () => untrackedCheck(facts)),
	]);
}

// -------------------------------------------------------------------- run

export async function runDoctor(
	p: DoctorProbes,
	opts: DoctorOptions = {},
): Promise<DoctorReport> {
	const loaded = await p.config().catch((e: unknown) => ({
		ok: false as const,
		error: e instanceof Error ? e.message : String(e),
	}));
	const projects = loaded.ok ? loaded.config.projects : [];
	const repoRoot = projects[0]?.root ?? p.home;

	const persistence = detectPersistence(p.host, p.home, repoRoot);
	// Awaited inside a guard; this keeps a rejection from going unhandled first.
	persistence.catch(() => {});

	const fixed = await Promise.all([
		guarded("host.bwrap", "host", () => bwrapCheck(p)),
		guarded("host.userns", "host", async () => {
			const [bwrap, trueBin] = await Promise.all([
				p.tool("bwrap"),
				p.tool("true"),
			]);
			return fromHostCheck(
				await detectUserns(p.host, {
					bwrap: bwrap.path,
					bwrapReal: bwrap.realPath ?? bwrap.path,
					trueBin: trueBin.path,
				}),
			);
		}),
		guarded("host.seccomp", "host", () => seccompCheck(p)),
		guarded("host.systemd", "host", async () =>
			fromHostCheck(await detectSystemdUser(p.host)),
		),
		guarded("host.linger", "host", async () => {
			// Without a real name the path is wrong and so would be the command.
			if (!p.host.user || p.host.user === "unknown") {
				return problem(
					"warn",
					"could not tell whether linger is on: this process has no user name",
					"loginctl enable-linger $USER",
				);
			}
			return fromHostCheck(await detectLinger(p.host));
		}),
		guarded("host.cgroup", "host", () => cgroupCheck(p)),
		guarded("host.tiocsti", "host", async () =>
			fromHostCheck(await detectTiocsti(p.host)),
		),
		guarded("tool.tmux", "tools", () =>
			toolCheck(
				p,
				"tmux",
				"-V",
				problem(
					"blocker",
					"tmux was not found",
					"install tmux (apt install tmux, dnf install tmux, pacman -S tmux, or nix profile install nixpkgs#tmux)",
				),
			),
		),
		guarded("tool.git", "tools", () =>
			toolCheck(
				p,
				"git",
				"--version",
				problem(
					"blocker",
					"git was not found",
					"install git (apt install git, dnf install git, pacman -S git, or nix profile install nixpkgs#git)",
				),
			),
		),
		guarded("tool.bun", "tools", () => ok(`bun ${p.bunVersion}`)),
		guarded("tool.openssl", "tools", () =>
			toolCheck(
				p,
				"openssl",
				"version",
				problem(
					"info",
					"openssl was not found (optional)",
					"install openssl if you generate your own TLS certificates",
				),
			),
		),
		guarded("storage.home", "storage", () => homeCheck(p)),
		guarded("storage.persistence", "storage", async () => {
			const c = await persistence;
			return c.value.ephemeral
				? fromHostCheck(c)
				: ok(
						`$MFW_HOME is on ${c.value.home?.fstype ?? "an unknown filesystem"}`,
					);
		}),
		guarded("storage.reflink", "storage", async () => {
			const c = await persistence;
			if (c.value.ephemeral) return skipped("$MFW_HOME is not persistent");
			return c.ok
				? ok("reflink seeds are available")
				: problem("info", c.detail, c.fix);
		}),
		guarded("storage.socket", "storage", () => socketCheck(p)),
		guarded("auth.state", "auth", () => authStateCheck(p)),
		guarded("auth.files", "auth", () => authFilesCheck(p)),
		guarded("install.config", "install", () =>
			loaded.ok
				? ok(`config is valid, ${projects.length} project(s)`)
				: problem(
						"blocker",
						`$MFW_HOME/config.json is invalid: ${loaded.error}`,
						"correct the file; the server will not start until it parses",
					),
		),
		guarded("install.build", "install", () => buildCheck(p)),
		guarded("install.legacy-host", "install", () => legacyCheck(p)),
		guarded("install.skills", "install", () =>
			skillsCheck(
				p,
				projects.map((e) => e.root),
			),
		),
		guarded("exposure.bind", "exposure", () => exposureCheck(p)),
	]);
	const harness = await harnessChecks(p, opts);
	const egress = await guarded("egress.allowlist", "egress", allowlistCheck);
	const perProject = await Promise.all(
		projects.map((entry) => projectChecks(p, entry)),
	);
	return buildReport([...fixed, ...harness, egress, ...perProject.flat()]);
}
