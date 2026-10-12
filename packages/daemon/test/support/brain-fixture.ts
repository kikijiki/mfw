import "./tmux-test-socket.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "@mfw/db/eventlog";
import { brainTurns } from "@mfw/db/schema";
import { desc, eq } from "drizzle-orm";
import type { AdapterRegistry } from "../../src/agents/adapter.ts";
import { boot, type ProjectConfig } from "../../src/boot.ts";
import type { StoredBrainConfig } from "../../src/config.ts";
import { git } from "../../src/git.ts";
import { silentLogger } from "../../src/log.ts";
import type { Orchestrator, ProjectServices } from "../../src/services.ts";
import { TEST_TMUX_SOCKET } from "./tmux-test-socket.ts";

export const FAKE_CLAUDE = join(
	import.meta.dir,
	"../fixtures/fake-claude-brain.ts",
);

export interface ArgvRecord {
	argv: string[];
	cwd: string;
	projectDir: string | null;
}

export interface BrainFixture {
	home: string;
	root: string;
	store: string;
	svc: ProjectServices;
	orchestrator: Orchestrator;
	/** Shut the daemon down (leaving tmux sessions alive) and boot a new one over the same state. */
	restart(): Promise<ProjectServices>;
	/** Every invocation the fake CLI has seen, oldest first. */
	argv(): Promise<ArgvRecord[]>;
	/** Behaviours for the next invocations (see fake-claude-brain.ts). */
	plan(...behaviours: string[]): Promise<void>;
	release(): Promise<void>;
	/** A human message to the brain: the immediate wake class. */
	humanMessage(text: string): Promise<void>;
	/** Run supervisor passes until `cond` holds. */
	until(
		cond: () => Promise<boolean>,
		opts?: { timeoutMs?: number; what?: string },
	): Promise<void>;
	/** Run supervisor passes until the newest turn has ended. */
	settleTurn(opts?: { timeoutMs?: number }): Promise<void>;
	turns(): Promise<(typeof brainTurns.$inferSelect)[]>;
	cleanup(): Promise<void>;
}

export async function brainFixture(
	opts: {
		brain?: Partial<StoredBrainConfig> | null;
		project?: Partial<ProjectConfig>;
	} = {},
): Promise<BrainFixture> {
	const base = await mkdtemp(join(tmpdir(), "mfw-test-brain-"));
	const home = join(base, "home");
	const root = join(base, "project");
	const store = join(base, "store");
	await mkdir(join(root, ".mfw"), { recursive: true });
	await mkdir(store, { recursive: true });
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "brain@test.invalid"], root);
	await git(["config", "user.name", "brain test"], root);
	await writeFile(join(root, "README.md"), "# brain\n");
	await writeFile(join(root, ".mfw", "AGENTS.md"), "brain test\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "fixture"], root);

	const config: ProjectConfig = {
		name: "brainy",
		root,
		integrationBranch: "main",
		provider: {
			id: "claude-cli",
			type: "claude-cli",
			env: { FAKE_BRAIN_STORE: store },
		},
		...(opts.brain === null
			? {}
			: {
					brain: {
						routes: [{ provider: "claude-cli", model: "sonnet" }],
						heartbeatMin: 100_000,
						...opts.brain,
					},
				}),
		...opts.project,
	};

	let orchestrator!: Orchestrator;
	let svc!: ProjectServices;
	const start = async () => {
		orchestrator = await boot({
			projects: [config],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		svc = orchestrator.get(config.name);
		// The real adapter argv, with the CLI swapped for the fake.
		const adapters = (
			svc.engine as unknown as { deps: { adapters: AdapterRegistry } }
		).deps.adapters;
		adapters.providerCommand = ["bun", "run", FAKE_CLAUDE];
		// Creates the session at the current head: enabling the brain never
		// replays history, so events the test emits afterwards are the wakes.
		await svc.brainRuntime.tick();
		return svc;
	};
	await start();

	const fx: BrainFixture = {
		home,
		root,
		store,
		get svc() {
			return svc;
		},
		get orchestrator() {
			return orchestrator;
		},
		async restart() {
			await orchestrator.shutdown();
			return start();
		},
		async argv() {
			try {
				return (await readFile(join(store, "argv.log"), "utf8"))
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as ArgvRecord);
			} catch {
				return [];
			}
		},
		async plan(...behaviours) {
			await writeFile(join(store, "plan.json"), JSON.stringify(behaviours));
		},
		async release() {
			await writeFile(join(store, "release"), "1");
		},
		async humanMessage(text) {
			const events = await svc.handle.withTx(async (tx) => [
				await appendEvent(tx, {
					type: "human.brain_message",
					payload: { text },
				}),
			]);
			svc.bus.publish(events);
		},
		async until(cond, o = {}) {
			const deadline = Date.now() + (o.timeoutMs ?? 30_000);
			for (;;) {
				await svc.supervisor.pass();
				if (await cond()) return;
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for ${o.what ?? "condition"}`);
				}
				await Bun.sleep(150);
			}
		},
		async turns() {
			return svc.handle.db
				.select()
				.from(brainTurns)
				.orderBy(desc(brainTurns.seq));
		},
		async settleTurn(o = {}) {
			await fx.until(
				async () => {
					const [t] = await fx.turns();
					return !!t && t.status !== "running";
				},
				{ timeoutMs: o.timeoutMs ?? 40_000, what: "the turn to end" },
			);
		},
		async cleanup() {
			await orchestrator.shutdown().catch(() => {});
			const killer = Bun.spawn(
				["tmux", "-L", TEST_TMUX_SOCKET, "kill-server"],
				{
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			await killer.exited;
			await rm(base, { recursive: true, force: true });
		},
	};
	return fx;
}

/** The turn row for a run id. */
export async function turnOf(fx: BrainFixture, runId: string) {
	const [t] = await fx.svc.handle.db
		.select()
		.from(brainTurns)
		.where(eq(brainTurns.runId, runId));
	return t;
}
