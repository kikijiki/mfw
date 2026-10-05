import { headSha } from "../git.ts";
import type { Logger } from "../log.ts";
import { runProc } from "../proc.ts";
import { signalOf } from "../verifier.ts";
import { WorktreeManager } from "../worktree.ts";
import type {
	TriggerActionHandler,
	TriggerActionResult,
	TriggerDispatch,
} from "./actions.ts";
import { eventRefs } from "./placeholders.ts";

/**
 * `action: script`: runs `sh -c run` via `runProc` (budgeted, group-killed,
 * output-capped). Payload fields reach the script only through
 * `MFW_EVENT_JSON`; `def.ts` refuses a `run` string with placeholders
 * (shell injection).
 */

const STDERR_TAIL = 8 * 1024; // matches the delivery record's cap
const SCRIPT_ENV_PASSTHROUGH = [
	"PATH",
	"HOME",
	"LANG",
	"TZ",
	// Lets `systemctl --user` / `systemd-run --user` (e.g. a deploy helper's
	// deferred restart) reach the daemon user's session manager.
	"DBUS_SESSION_BUS_ADDRESS",
	"XDG_RUNTIME_DIR",
] as const;

/** Concurrency pool for script actions, separate from `maxConcurrent` (LLM spend) so neither starves the other. */
export class Semaphore {
	private inFlight = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(private readonly max: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.inFlight >= this.max) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			this.waiters.shift()?.();
		}
	}
}

export interface ScriptSecretsStore {
	getSecret(name: string): Promise<string | undefined>;
}

export interface ScriptActionDeps {
	log: Logger;
	secrets: ScriptSecretsStore;
	semaphore: Semaphore;
	/** Process environment is injectable so the security boundary is testable. */
	environment?: Readonly<Record<string, string | undefined>>;
}

export function createScriptAction(
	deps: ScriptActionDeps,
): TriggerActionHandler {
	return (dispatch) => deps.semaphore.run(() => runScript(dispatch, deps));
}

async function runScript(
	dispatch: TriggerDispatch,
	deps: ScriptActionDeps,
): Promise<TriggerActionResult> {
	const action = dispatch.def.action;
	if (action.kind !== "script") {
		throw new Error("createScriptAction wired to a non-script action");
	}

	// Requested-but-not-granted refuses to dispatch rather than passing an empty
	// string. Defense in depth: the dispatch service already excludes such triggers.
	for (const name of dispatch.def.secrets) {
		if (!dispatch.grantedSecrets.includes(name)) {
			return {
				ok: false,
				detail: `secret "${name}" is requested but not granted by the arming record, refusing to dispatch`,
			};
		}
	}

	const payload = (dispatch.event.payload ?? {}) as Record<string, unknown>;
	const { taskId, runId } = eventRefs(dispatch.event);
	const sha =
		typeof payload.sha === "string" && payload.sha.length > 0
			? payload.sha
			: await headSha(dispatch.projectRoot).catch(() => "");

	const env: Record<string, string> = {};
	const sourceEnv = deps.environment ?? process.env;
	for (const key of SCRIPT_ENV_PASSTHROUGH) {
		const v = sourceEnv[key];
		if (v !== undefined) env[key] = v;
	}
	env.MFW_DELIVERY_ID = dispatch.deliveryId;
	env.MFW_PROJECT = dispatch.projectName;
	env.MFW_TRIGGER_ID = dispatch.def.id;
	env.MFW_EVENT_TYPE = dispatch.event.type;
	env.MFW_EVENT_SEQ = String(dispatch.event.seq);
	env.MFW_EVENT_TS = String(dispatch.event.ts);
	env.MFW_TASK_ID = taskId ?? "";
	env.MFW_RUN_ID = runId ?? "";
	env.MFW_SHA = sha;
	env.MFW_EVENT_JSON = JSON.stringify(payload);

	for (const name of dispatch.def.secrets) {
		const value = await deps.secrets.getSecret(name);
		if (value === undefined) {
			return {
				ok: false,
				detail: `secret "${name}" is granted but not set in credentials.json`,
			};
		}
		env[name.toUpperCase()] = value;
	}

	const worktrees = new WorktreeManager(dispatch.projectRoot);
	let worktree: Awaited<ReturnType<WorktreeManager["create"]>> | null = null;
	let cwd = dispatch.projectRoot;
	if (action.cwd === "worktree") {
		// Hermetic, detached at the sha, but has no installed dependencies; hence
		// `repo` (the primary checkout with `node_modules`/`.env`) is the default.
		worktree = await worktrees.create(
			`trigger-${dispatch.deliveryId}`,
			sha || "HEAD",
		);
		cwd = worktree.path;
	}

	try {
		// One shell, no wrapper prefix: for a single external command `sh -c` execs
		// it, so exitCode/signalCode describe it directly. For multi-statement
		// `run` (`foo && bar`) sh forks and a crash shows as sh's 128+signal exit.
		// Harmless here: a crash and a non-zero exit both mean "delivery failed".
		const result = await runProc(["sh", "-c", action.run], {
			cwd,
			env,
			timeoutMs: action.timeoutMs,
		});
		const ok = result.exitCode === 0 && !result.timedOut;
		const signal = result.signalCode ?? signalOf(result.exitCode);
		return {
			ok,
			exitCode: result.exitCode ?? undefined,
			detail: ok
				? undefined
				: result.timedOut
					? `timed out after ${action.timeoutMs}ms`
					: signal
						? `killed by a signal (${signal}): ${result.stderr.slice(-STDERR_TAIL)}`
						: `exit ${result.exitCode}: ${result.stderr.slice(-STDERR_TAIL)}`,
		};
	} finally {
		// Scratch worktree for one delivery: always removed, even if dirty.
		if (worktree) await worktrees.remove(worktree);
	}
}
