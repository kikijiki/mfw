import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostSlotLedger } from "./host-service.ts";
import { runProc } from "./proc.ts";

/**
 * Codex concurrency: one run at a time per `CODEX_HOME` while the login is a
 * ChatGPT subscription (several app-servers on one ChatGPT login race the
 * token refresh and trip the account). An API key lifts the limit.
 *
 * The limit is a machine-wide host slot, `codex.<home>.slots`, in the same
 * FIFO ledger as every other host capacity, so a second Codex task waits for
 * the first with the usual fencing and recovery, across projects. The auth
 * mode comes from `codex login status` (stdout names the mode; the key itself
 * is never read, kept or logged). Anything that is not a clear API key keeps
 * the limit at 1: unknown fails safe.
 */

export type CodexAuthMode = "chatgpt" | "api-key" | "none" | "unknown";

/** What one `codex login status` call gave. */
export interface CodexLoginOutput {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export type CodexLoginRunner = (
	env: NodeJS.ProcessEnv,
) => Promise<CodexLoginOutput>;

/**
 * Interpret `codex login status`. It prints "Logged in using ChatGPT" or
 * "Logged in using an API key - <masked>", and "Not logged in" with a
 * non-zero exit. Both streams are read (the CLI writes status to either).
 */
export function parseCodexLoginStatus(out: CodexLoginOutput): CodexAuthMode {
	const text = `${out.stdout}\n${out.stderr}`.toLowerCase();
	if (/\bnot logged in\b/.test(text)) return "none";
	if (/logged in using (?:an )?api[ -]?key/.test(text)) return "api-key";
	if (/logged in using chatgpt/.test(text)) return "chatgpt";
	return "unknown";
}

/** Slots one login allows at once; null = unbounded. */
export function codexConcurrencyLimit(mode: CodexAuthMode): number | null {
	return mode === "api-key" ? null : 1;
}

/** The directory the Codex CLI keeps its login in. */
export function codexHomeOf(env: NodeJS.ProcessEnv): string {
	return env.CODEX_HOME?.trim() || join(env.HOME || homedir(), ".codex");
}

/** Coordinator id of the slot guarding one `CODEX_HOME` (a hash: never a path). */
export function codexSlotResourceId(codexHome: string): string {
	const id = createHash("sha256").update(codexHome).digest("hex").slice(0, 12);
	return `codex.${id}.slots`;
}

export interface CodexLaneDeps {
	ledger: HostSlotLedger;
	env?: () => NodeJS.ProcessEnv;
	/** Test seam; default spawns `<command> login status`. */
	run?: CodexLoginRunner;
	/** The Codex binary; default `codex` on PATH. */
	command?: string;
	/** How long a detected mode is trusted. Default 60 s. */
	ttlMs?: number;
	now?: () => number;
}

export class CodexLane {
	private cached: { mode: CodexAuthMode; at: number; home: string } | null =
		null;

	constructor(private readonly deps: CodexLaneDeps) {}

	private get env(): NodeJS.ProcessEnv {
		return this.deps.env?.() ?? process.env;
	}

	async authMode(): Promise<CodexAuthMode> {
		const env = this.env;
		const home = codexHomeOf(env);
		const now = (this.deps.now ?? Date.now)();
		const c = this.cached;
		if (c && c.home === home && now - c.at < (this.deps.ttlMs ?? 60_000))
			return c.mode;
		let mode: CodexAuthMode;
		try {
			const run =
				this.deps.run ??
				(async (e) => {
					const r = await runProc(
						[this.deps.command ?? "codex", "login", "status"],
						{ env: e, timeoutMs: 10_000, maxOutputBytes: 16_384 },
					);
					return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
				});
			mode = parseCodexLoginStatus(await run({ ...env, CODEX_HOME: home }));
		} catch {
			mode = "unknown";
		}
		this.cached = { mode, at: now, home };
		return mode;
	}

	/**
	 * The host requirement a local Codex run must hold, with its slot resource
	 * defined at the right capacity; null when the login allows parallelism.
	 */
	async requirement(): Promise<{
		scope: "host";
		id: string;
		amount: 1;
	} | null> {
		const mode = await this.authMode();
		if (codexConcurrencyLimit(mode) === null) return null;
		const id = codexSlotResourceId(codexHomeOf(this.env));
		const current = this.deps.ledger
			.readModel()
			.definitions.find((d) => d.id === id);
		if (
			!current ||
			current.capacity !== 1n ||
			!current.enabled ||
			current.draining
		) {
			await this.deps.ledger.putDefinition(
				{
					id,
					accounting: "slot",
					provisioning: "static",
					capacity: 1n,
					enabled: true,
					draining: false,
					version: current?.version ?? 1n,
					metadata: { kind: "codex-home" },
				},
				{
					actor: "codex-lane",
					reason: `Codex login is ${mode}: one run at a time`,
				},
			);
		}
		return { scope: "host", id, amount: 1 };
	}
}
