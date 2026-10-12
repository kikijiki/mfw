#!/usr/bin/env bun
/**
 * `bun run screenshots`: spin up a throwaway mfw under /tmp, give it three dummy
 * projects with a believable week of history, and photograph every main
 * section of the web app in headless Firefox. See apps/start/src/README.md.
 *
 *   bun run screenshots [--out DIR] [--sizes 1440x900] [--scale 2]
 *       [--theme dark|light|both] [--only a,b] [--publish-dir DIR]
 *       [--dry-run] [--firefox PATH]
 *
 * The run (own MFW_HOME, dev-server port, tmux socket, dummy git repositories)
 * lives in /tmp/mfw-screenshots-<timestamp>/; the PNGs and index.json land
 * in docs/screenshots/ unless --out says otherwise.
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { windowBounds } from "@mfw/daemon/budgets";
import { openProjectDb } from "@mfw/db/client";
import { ulid } from "@mfw/db/ids";
import { brainSessions, spendLedger } from "@mfw/db/schema";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
	Browser,
	freezeClockScript,
	storageScript,
} from "./screenshots/browser.ts";
import {
	buildManifest,
	DEFAULT_OUT,
	fileName,
	type IdMaps,
	type ManifestEntry,
	type Options,
	parseAgo,
	parseArgs,
	resolvePath,
	SECTIONS,
	type Section,
	type SeedProject,
	type SkippedEntry,
	selectSections,
	sizeName,
	sizesFor,
	USAGE,
	UsageError,
	validateSections,
	validateSeedPlan,
} from "./screenshots/plan.ts";
import { seedHistory } from "./screenshots/seedHistory.ts";
import { SEED_PLAN } from "./screenshots/seedPlan.ts";
import { type BuiltRepo, buildRepo, git } from "./screenshots/seedRepos.ts";
import {
	type DevServer,
	freePort,
	killTmuxServer,
	startDevServer,
	trpc,
} from "./screenshots/server.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const APP_DIR = join(REPO_ROOT, "apps", "start");
const BOARD_CLI = join(REPO_ROOT, "packages", "board", "src", "cli.ts");

const LIVE_PROJECT = "harbor-api";
const WATCHDOG_OFF = { idleMs: 0, wallMs: 0, maxTurns: 0 };

/** The page clock sits this far after the seed instant, so nothing seeded is "in the future". */
const CLOCK_LAG_MIN = 8;

const log = (msg: string) => console.log(msg);

// ---- cleanup --------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = [];
let cleaning: Promise<void> | null = null;

function cleanup(): Promise<void> {
	cleaning ??= (async () => {
		for (const fn of cleanups.reverse()) {
			try {
				await fn();
			} catch {
				// best effort: keep tearing down
			}
		}
	})();
	return cleaning;
}

function installSignalHandlers(): void {
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(sig, () => {
			console.error(`\n${sig}: tearing down`);
			void cleanup().finally(() => process.exit(130));
		});
	}
}

// ---- helpers --------------------------------------------------------------

function gitSha(): string {
	const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return r.status === 0 ? r.stdout.trim() : "unknown";
}

async function cli(
	boardYaml: string,
	args: string[],
): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(["bun", BOARD_CLI, "--config", boardYaml, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, MFW_BOARD: "" },
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out: out.trim(), err: err.trim() };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// ---- dry run --------------------------------------------------------------

function dryRun(opts: Options): void {
	const problems = [
		...validateSeedPlan(SEED_PLAN),
		...validateSections(SECTIONS, SEED_PLAN),
	];
	const sections = selectSections(opts.only);
	log(`sections (${sections.length}):`);
	for (const s of sections) {
		const sizes = sizesFor(s, opts.sizes).map(sizeName).join(",");
		log(
			`  ${s.name.padEnd(20)} ${s.optional ? "(optional) " : ""}${sizes.padEnd(10)} ${s.path}`,
		);
	}
	log("\nseed plan:");
	for (const p of SEED_PLAN.projects) {
		log(
			`  ${p.name}: ${p.template}${p.separateBoard ? " (separate board folder)" : ""}, ${p.tasks.length} tasks, ${p.runs.length} runs, ${(p.groups ?? []).length} groups, ${p.brain?.turns.length ?? 0} brain turns`,
		);
	}
	log(
		`\nfiles per run: ${sections.length} sections x ${opts.themes.length} theme(s), at ${opts.sizes.map(sizeName).join(", ")} @${opts.scale}x`,
	);
	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  - ${p}`);
		process.exit(1);
	}
	log(
		"\ndry run ok: section list and seed plan are valid; nothing was launched",
	);
}

// ---- seeding --------------------------------------------------------------

interface SeededProject {
	project: SeedProject;
	built: BuiltRepo;
	name: string;
	taskIds: Map<string, string>;
	runIds: Map<string, string>;
	groupIds: Map<string, string>;
	seenSeq: number;
}

const STUB_AGENT = `#!/bin/sh
echo "mfw screenshots: no real agents are available in this run" >&2
exit 1
`;

async function main(): Promise<number> {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(USAGE);
		return 0;
	}
	if (opts.dryRun) {
		dryRun(opts);
		return 0;
	}
	const problems = [
		...validateSeedPlan(SEED_PLAN),
		...validateSections(SECTIONS, SEED_PLAN),
	];
	if (problems.length > 0) {
		for (const p of problems) console.error(`  - ${p}`);
		throw new Error("the seed plan or the section list is invalid");
	}
	const sections = selectSections(opts.only);
	installSignalHandlers();

	const t0 = Date.now();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join("/tmp", `mfw-screenshots-${stamp}`);
	const mfwHome = join(runDir, "mfw-home");
	const reposDir = join(runDir, "repos");
	const binDir = join(runDir, "bin");
	const outDir = resolve(opts.out ?? join(REPO_ROOT, DEFAULT_OUT));
	await mkdir(mfwHome, { recursive: true });
	await mkdir(reposDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(outDir, { recursive: true });
	for (const name of ["claude", "codex"]) {
		await writeFile(join(binDir, name), STUB_AGENT);
		await chmod(join(binDir, name), 0o755);
	}
	const tmuxSocket = `mfw-shots-${process.pid}`;
	cleanups.push(() => killTmuxServer(tmuxSocket));
	const timings: Record<string, number> = {};
	const lap = (name: string, from: number) => {
		timings[name] = Math.round((Date.now() - from) / 100) / 10;
	};
	log(`run directory: ${runDir}`);

	const seedNow = Date.now() + CLOCK_LAG_MIN * 60_000;
	const at = (ago: string) => seedNow - parseAgo(ago) * 60_000;

	// 1. repositories -------------------------------------------------------
	let t = Date.now();
	const seeded: SeededProject[] = [];
	for (const project of SEED_PLAN.projects) {
		const runIds = new Map<string, string>();
		for (const r of project.runs) runIds.set(r.alias, ulid(at(r.start)));
		const groupIds = new Map<string, string>();
		for (const g of project.groups ?? [])
			groupIds.set(g.alias, ulid(at(g.start)));
		const taskTitles = new Map(
			project.tasks.map((x) => [x.alias, x.title] as const),
		);
		const built = await buildRepo({
			project,
			reposDir,
			seedNow,
			runIds,
			taskTitles,
		});
		seeded.push({
			project,
			built,
			name: project.name,
			taskIds: new Map(),
			runIds,
			groupIds,
			seenSeq: 0,
		});
		log(`  repository ${project.name}`);
	}
	// A repository nothing is attached to, so the Add project dialog has one to pick.
	const spare = join(reposDir, "inventory-sync");
	await mkdir(spare, { recursive: true });
	await git(["init", "-q", "-b", "main"], spare);
	await writeFile(
		join(spare, "README.md"),
		"# inventory-sync\n\nNightly stock reconciliation.\n",
	);
	await git(["add", "-A"], spare);
	await git(
		[
			"-c",
			"user.name=Mara Lindqvist",
			"-c",
			"user.email=mara@example.com",
			"commit",
			"-q",
			"-m",
			"chore: initial commit",
		],
		spare,
	);
	lap("repositories", t);

	// 2. attach the projects through the real API ------------------------------
	t = Date.now();
	const fakeEnv = {
		MFW_HOME: mfwHome,
		MFW_TMUX_SOCKET: tmuxSocket,
		HOME: reposDir,
		CLAUDE_CONFIG_DIR: join(runDir, "claude-config"),
		CODEX_HOME: join(runDir, "codex-home"),
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		TZ: "UTC",
		LANG: "en_US.UTF-8",
		MFW_USAGE_CLAUDE_OAUTH: "0",
	};
	const attach = await startServer(fakeEnv, runDir, "attach");
	for (const s of seeded) {
		const input: Record<string, unknown> = {
			name: s.project.name,
			root: s.built.root,
			integrationBranch: "main",
			template: s.project.template,
			schedulerAutostart: false,
			maxConcurrent: 2,
		};
		if (s.project.separateBoard) {
			input.boardRoot = s.built.boardRoot;
			input.createBoardFolder = true;
		}
		await trpc(attach.base, "system.addProject", input);
		log(`  attached ${s.project.name} (${s.project.template})`);
	}
	await attach.stop();
	lap("attach", t);

	// 3. the board: tasks and ADRs through mfwb --------------------------------
	t = Date.now();
	for (const s of seeded) {
		const boardYaml = join(s.built.boardRoot, "board.yaml");
		if (!existsSync(boardYaml))
			throw new Error(`no board.yaml at ${boardYaml}`);
		for (const task of s.project.tasks) {
			const args = [
				"create",
				"--body",
				task.body ?? "",
				`title=${task.title}`,
				`status=${task.status}`,
				`type=${task.type ?? "implementation"}`,
				`priority=${task.priority ?? "medium"}`,
				`created=${iso(at(task.created))}`,
			];
			if (task.size) args.push(`size=${task.size}`);
			if (task.labels?.length) args.push(`labels=${task.labels.join(",")}`);
			if (task.owns?.length) args.push(`owns=${task.owns.join(",")}`);
			if (task.parent) args.push(`parent=${s.taskIds.get(task.parent)}`);
			if (task.dependsOn?.length)
				args.push(
					`depends_on=${task.dependsOn.map((d) => s.taskIds.get(d)).join(",")}`,
				);
			if (task.blockedReason) args.push(`blocked_reason=${task.blockedReason}`);
			if (task.criteria?.length)
				args.push(
					`acceptance=${JSON.stringify(
						task.criteria.map((text, i) => ({
							id: `c${i + 1}`,
							text,
							done: task.status === "done",
						})),
					)}`,
				);
			const r = await cli(boardYaml, args);
			const id = /^task ([A-Z][A-Z0-9]*-\d+)/m.exec(r.out)?.[1];
			if (r.code !== 0 || !id)
				throw new Error(
					`mfwb create failed for '${task.title}': ${r.err || r.out}`,
				);
			s.taskIds.set(task.alias, id);
		}
		for (const adr of s.project.adrs ?? []) {
			const r = await cli(boardYaml, [
				"create",
				"--type",
				"adr",
				"--body",
				adr.body,
				`title=${adr.title}`,
				`status=${adr.status}`,
				`date=${adr.date}`,
			]);
			if (r.code !== 0)
				throw new Error(`mfwb create adr failed: ${r.err || r.out}`);
		}
		log(`  board ${s.project.name}: ${s.taskIds.size} tasks`);
	}
	lap("board", t);

	// 4. history ---------------------------------------------------------------
	t = Date.now();
	for (const s of seeded) {
		const res = await seedHistory({
			project: s.project,
			root: s.built.root,
			seedNow,
			taskIds: s.taskIds,
			runIds: s.runIds,
			groupIds: s.groupIds,
			runGit: s.built.runs,
			hostname: hostname(),
		});
		s.seenSeq = res.seenSeq;
		log(`  history ${s.project.name}: ${res.eventCount} events`);
	}
	lap("history", t);

	// 5. configuration the API cannot set: brain, watchdog, budgets, usage -------
	await configure(mfwHome, seeded, runDir, seedNow);

	// Live runs: claim their tasks and give them a tmux session to be live in.
	for (const s of seeded) {
		const boardYaml = join(s.built.boardRoot, "board.yaml");
		for (const r of s.project.runs.filter((x) => x.end === "live")) {
			const runId = s.runIds.get(r.alias) as string;
			const taskId = s.taskIds.get(r.task) as string;
			const wt = s.built.runs.get(r.alias)?.worktree ?? s.built.root;
			const c = await cli(boardYaml, [
				"claim",
				taskId,
				"--run",
				runId,
				"--worktree",
				wt,
				"--lease-ms",
				String(7 * 24 * 3600 * 1000),
				"--from",
				"in_progress",
			]);
			if (c.code !== 0) log(`  note: could not claim ${taskId}: ${c.err}`);
		}
	}

	// When each task last changed status (the "review ready 2h ago" on Home reads this sidecar).
	for (const s of seeded) {
		const dir = join(s.built.root, ".mfw", "state", "tasks");
		await mkdir(dir, { recursive: true });
		for (const task of s.project.tasks) {
			const id = s.taskIds.get(task.alias) as string;
			const last = task.moves?.at(-1)?.ago ?? task.created;
			const file = join(dir, `${id}.json`);
			let lease: Record<string, unknown> = {
				claimedByGroupId: null,
				leadRunId: null,
				claimedAt: null,
				leaseExpiresAt: null,
				worktree: null,
			};
			if (existsSync(file)) lease = JSON.parse(readFileSync(file, "utf8"));
			lease.statusChangedAt = at(last);
			writeFileSync(file, `${JSON.stringify(lease, null, 2)}\n`);
		}
	}

	// 6. the server the screenshots are taken from -----------------------------
	t = Date.now();
	const usageFile = join(runDir, "usage-fixture.json");
	const shots = await startServer(
		{ ...fakeEnv, MFW_USAGE_FIXTURE: usageFile },
		runDir,
		"capture",
		opts.port,
	);
	cleanups.push(() => shots.stop());
	// Live runs: a tmux session each, then attach their project so its reconcile adopts them.
	const live = seeded.find((x) => x.name === LIVE_PROJECT);
	if (live) {
		for (const r of live.project.runs.filter((x) => x.end === "live")) {
			const runId = live.runIds.get(r.alias) as string;
			const wt = live.built.runs.get(r.alias)?.worktree ?? live.built.root;
			const tm = spawnSync("tmux", [
				"-L",
				tmuxSocket,
				"new-session",
				"-d",
				"-s",
				`mfw_${runId}`,
				"-c",
				wt,
				"sleep 86400",
			]);
			if (tm.status !== 0)
				throw new Error(`tmux new-session failed: ${tm.stderr}`);
		}
		await trpc(shots.base, "system.addProject", {
			name: live.project.name,
			root: live.built.root,
			integrationBranch: "main",
			template: live.project.template,
			schedulerAutostart: false,
			maxConcurrent: 2,
		});
		const brain = live.project.brain;
		await trpc(shots.base, "settings.update", {
			project: live.project.name,
			patch: {
				watchdog: WATCHDOG_OFF,
				...(brain
					? {
							brain: {
								routes: [
									{
										provider: "claude-cli",
										model: brain.model,
										effort: "high",
									},
								],
								heartbeatMin: 60 * 24 * 30,
							},
						}
					: {}),
			},
		});
	}
	await Bun.sleep(4_000); // let the supervisor's first pass settle
	lap("server", t);

	// Ids the section paths use.
	const ids: IdMaps = { projects: {}, tasks: {}, runs: {}, groups: {} };
	for (const s of seeded) {
		ids.projects[s.project.key] = s.name;
		ids.tasks[s.project.key] = Object.fromEntries(s.taskIds);
		for (const [alias, id] of s.runIds) ids.runs[alias] = id;
		for (const [alias, id] of s.groupIds) ids.groups[alias] = id;
	}
	writeFileSync(
		join(runDir, "seed-info.json"),
		JSON.stringify(
			{
				seedNow,
				ids,
				seen: Object.fromEntries(seeded.map((s) => [s.name, s.seenSeq])),
			},
			null,
			2,
		),
	);

	// 7. capture -----------------------------------------------------------------
	t = Date.now();
	const seen: Record<string, string> = {};
	for (const s of seeded)
		seen[`mfw:v2:history:seen:${s.name}`] = String(s.seenSeq);
	const result = await capture({
		base: shots.base,
		sections,
		opts,
		ids,
		outDir,
		clockMs: seedNow,
		storage: seen,
	});
	lap("capture", t);

	// 8. manifest, publish -------------------------------------------------------
	const manifest = buildManifest({
		generatedAt: new Date().toISOString(),
		commit: gitSha(),
		scale: opts.scale,
		themes: opts.themes,
		screenshots: result.entries,
		skipped: result.skipped,
	});
	writeFileSync(
		join(outDir, "index.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	if (opts.publishDir) {
		const dest = resolve(opts.publishDir);
		mkdirSync(dest, { recursive: true });
		for (const e of manifest.screenshots)
			copyFileSync(join(outDir, e.file), join(dest, e.file));
		copyFileSync(join(outDir, "index.json"), join(dest, "index.json"));
		log(`published ${manifest.screenshots.length} images to ${dest}`);
	}

	// ---- report ----
	log(`\nscreenshots: ${outDir}`);
	log(
		`captured ${manifest.screenshots.length}, skipped ${manifest.skipped.length}`,
	);
	for (const s of manifest.skipped) log(`  skipped ${s.name}: ${s.reason}`);
	log(
		`timings (s): ${Object.entries(timings)
			.map(([k, v]) => `${k} ${v}`)
			.join(", ")}, total ${Math.round((Date.now() - t0) / 100) / 10}`,
	);
	if (result.problems.length > 0) {
		console.error(`\n${result.problems.length} problem(s) while capturing:`);
		for (const p of result.problems) console.error(`  - ${p}`);
		return 1;
	}
	log("no console errors, failed requests or exceptions");
	return 0;
}

// ---- configuration -----------------------------------------------------------

/**
 * The project with live runs is attached after boot (see `main`): at boot each
 * project's reconcile kills tmux sessions it does not own, so a live run only
 * survives in the project attached last, after its session exists.
 */
async function configure(
	mfwHome: string,
	seeded: SeededProject[],
	runDir: string,
	seedNow: number,
): Promise<void> {
	const configPath = join(mfwHome, "config.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		projects: Array<Record<string, unknown>>;
		budgets?: Record<string, unknown>;
	};
	for (const entry of config.projects) {
		const s = seeded.find((x) => x.name === entry.name);
		if (!s) continue;
		// No watchdog: the live runs are fixtures, not processes producing output.
		entry.watchdog = WATCHDOG_OFF;
	}
	// The project with live runs is attached after boot.
	config.projects = config.projects.filter((p) => p.name !== LIVE_PROJECT);

	// Budgets: sized from the seeded spend so the meters show real fractions.
	const week = windowBounds("7d", Date.now());
	let weekSpend = 0;
	for (const s of seeded) {
		const handle = await openProjectDb(join(s.built.root, ".mfw"));
		const sum = async (from: number, to: number) => {
			const [r] = await handle.db
				.select({ usd: sql<number>`coalesce(sum(${spendLedger.usd}), 0)` })
				.from(spendLedger)
				.where(
					and(
						eq(spendLedger.accountKey, "claude-cli"),
						eq(spendLedger.kind, "agent"),
						gte(spendLedger.ts, new Date(from)),
						lt(spendLedger.ts, new Date(to)),
					),
				);
			return Number(r?.usd ?? 0);
		};
		weekSpend += await sum(week.start, week.end);

		// The brain's wake cursor sits at the end of history: nothing is pending.
		await handle.db.update(brainSessions).set({ cursor: 1_000_000_000 });
		handle.close();
	}
	const round5 = (n: number) => Math.max(5, Math.ceil(n / 5) * 5);
	config.budgets = {
		agents: {
			"claude-cli": {
				window: "7d",
				limitUsd: round5(weekSpend / 0.58),
				warnAt: 0.8,
			},
		},
		brain: { window: "1d", limitUsd: 5, warnAt: 0.8 },
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);

	// The usage meters: a fixed snapshot, absolute reset instants.
	const fixture = {
		subscriptions: SEED_PLAN.usage.subscriptions.map((sub) => ({
			provider: sub.provider,
			name: sub.name,
			accountLabel: sub.accountLabel,
			windows: sub.windows.map((w) => ({
				label: w.label,
				usedPercent: w.usedPercent,
				resetsAt: seedNow + w.resetsInMinutes * 60_000,
				windowMinutes: w.windowMinutes,
			})),
		})),
	};
	writeFileSync(
		join(runDir, "usage-fixture.json"),
		JSON.stringify(fixture, null, 2),
	);
}

async function startServer(
	env: Record<string, string>,
	runDir: string,
	label: string,
	port?: number | null,
): Promise<DevServer> {
	const chosen = port ?? (await freePort());
	const server = await startDevServer({
		appDir: APP_DIR,
		port: chosen,
		env,
		logFile: join(runDir, `server-${label}.log`),
	});
	cleanups.push(() => server.stop());
	log(`  dev server (${label}) on ${server.base}`);
	return server;
}

// ---- capture ---------------------------------------------------------------------

interface CaptureInput {
	base: string;
	sections: Section[];
	opts: Options;
	ids: IdMaps;
	outDir: string;
	clockMs: number;
	storage: Record<string, string>;
}

type ActionResult = { skip?: string } | undefined;
type Action = (b: Browser) => Promise<ActionResult>;

const ACTIONS: Record<string, Action> = {
	async waitBoard(b) {
		await b.waitFor("main");
		return undefined;
	},
	async waitFlow(b) {
		if (!(await b.waitFor('[role="treegrid"]', 15_000)))
			return { skip: "the Flow tree did not render" };
		return undefined;
	},
	async boardColumns(b) {
		const clicked =
			(await b.clickText("columns", "button,[role=tab],[role=radio]")) ||
			(await b.clickText("column layout", "button,[role=tab],[role=radio]"));
		return clicked
			? undefined
			: { skip: "not available in this build (no board layout switch)" };
	},
	async palette(b) {
		await b.key(["Control", "k"]);
		if (!(await b.waitFor("[cmdk-root], [role=dialog]", 5_000)))
			return { skip: "the command palette did not open" };
		return undefined;
	},
	async addProjectStep1(b) {
		if (!(await b.clickText("add project")))
			return { skip: "no Add project control found" };
		if (!(await b.waitFor("[role=dialog]", 5_000)))
			return { skip: "the Add project dialog did not open" };
		return undefined;
	},
	async addProjectStep2(b) {
		if (!(await b.clickText("add project")))
			return { skip: "no Add project control found" };
		if (!(await b.waitFor("[role=dialog]", 5_000)))
			return { skip: "the Add project dialog did not open" };
		await b.settle(500, 8_000);
		// Pick the repository nothing is attached to.
		const picked = await b.eval<boolean>(`(() => {
			const rows = [...document.querySelectorAll('[role=dialog] li, [role=dialog] [role=option], [role=dialog] button')];
			const row = rows.find((r) => /inventory-sync/.test(r.textContent || ''));
			if (!row) return false;
			const btn = row.matches('button') ? row : row.querySelector('button');
			(btn || row).click();
			return true;
		})()`);
		if (!picked) return { skip: "the spare repository was not offered" };
		await b.settle(400, 5_000);
		if (!(await b.clickText("next: board", "[role=dialog] button")))
			await b.clickText("next", "[role=dialog] button");
		await b.settle(500, 8_000);
		return undefined;
	},
};

async function capture(input: CaptureInput): Promise<{
	entries: ManifestEntry[];
	skipped: SkippedEntry[];
	problems: string[];
}> {
	const { opts } = input;
	const entries: ManifestEntry[] = [];
	const skipped: SkippedEntry[] = [];
	const problems: string[] = [];
	const skippedNames = new Set<string>();
	const browser = new Browser();
	cleanups.push(() => browser.close());
	await browser.launch({
		binary: opts.firefox,
		env: { TZ: "UTC", LANG: "en_US.UTF-8" },
	});

	for (const section of input.sections) {
		for (const theme of opts.themes) {
			for (const size of sizesFor(section, opts.sizes)) {
				if (skippedNames.has(section.name)) continue;
				const route = resolvePath(section.path, input.ids);
				const storage: Record<string, string> = {
					...input.storage,
					"mfw:v2:theme": theme,
					"mfw:v2:density": "comfortable",
					"mfw:v2:sidebar": "expanded",
					...section.storage,
				};
				await browser.setViewport(size.w, size.h, opts.scale);
				await browser.setPreload(
					`${process.env.MFW_SHOTS_NOFREEZE ? "" : freezeClockScript(input.clockMs)}\n${storageScript(storage)}`,
				);
				browser.takeIssues();
				const status = await browser.goto(`${input.base}${route}`);
				await browser.settle();
				const missing = await browser.eval<boolean>(
					`/\\b(page not found|not found)\\b/i.test(document.body.innerText) && document.body.innerText.length < 400`,
				);
				if (status === 404 || missing) {
					if (section.optional) {
						const reason =
							"not available in this build (the route is not found)";
						skipped.push({ name: section.name, title: section.title, reason });
						skippedNames.add(section.name);
						log(`  - ${section.name}: ${reason}`);
						continue;
					}
					problems.push(`${section.name}: ${route} is not found`);
				}
				if (section.action) {
					const action = ACTIONS[section.action];
					if (!action) throw new Error(`unknown action '${section.action}'`);
					const r = await action(browser);
					await browser.settle(500, 10_000);
					if (r?.skip) {
						if (section.optional) {
							skipped.push({
								name: section.name,
								title: section.title,
								reason: r.skip,
							});
							skippedNames.add(section.name);
							log(`  - ${section.name}: ${r.skip}`);
							continue;
						}
						problems.push(`${section.name}: ${r.skip}`);
					}
				}
				if (section.waitFor && !(await browser.waitFor(section.waitFor))) {
					problems.push(`${section.name}: '${section.waitFor}' never appeared`);
				}
				if (section.full) {
					const height = await browser.eval<number>(
						"Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('main, [data-scroll], .overflow-auto, .overflow-y-auto')].map((e) => e.scrollHeight))",
					);
					await browser.setViewport(
						size.w,
						Math.min(Math.max(height, size.h), 4000),
						opts.scale,
					);
					await browser.settle(500, 8_000);
				}
				// MFW_SHOTS_HOVER="<css selector>": hover that element before the shot
				// (to look at a tooltip); the file name gains a `-hover` suffix.
				const hoverSel = process.env.MFW_SHOTS_HOVER;
				if (hoverSel && !(await browser.hover(hoverSel))) {
					log(`  (hover: nothing matches ${hoverSel} on ${section.name})`);
				}
				await Bun.sleep(250);
				const file = fileName(section.name, theme, size);
				await browser.screenshot(join(input.outDir, file));
				for (const issue of browser.takeIssues()) {
					problems.push(
						`${section.name} (${theme}, ${sizeName(size)}): ${issue.kind}: ${issue.text}`,
					);
				}
				entries.push({
					name: section.name,
					title: section.title,
					path: file,
					file,
					viewport: size,
					scale: opts.scale,
					theme,
					route,
				});
				log(`  ${file}`);
			}
		}
	}
	if (browser.knownWarnings > 0)
		log(
			`  (ignored ${browser.knownWarnings} known React hydration warning(s): saved theme applied before hydration)`,
		);
	await browser.close();
	return { entries, skipped, problems };
}

// ---- entry ---------------------------------------------------------------------

let exitCode = 1;
try {
	exitCode = await main();
} catch (e) {
	if (e instanceof UsageError) {
		console.error(`${e.message}\n\n${USAGE}`);
		exitCode = 2;
	} else {
		console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
		exitCode = 1;
	}
} finally {
	await cleanup();
}
process.exit(exitCode);
