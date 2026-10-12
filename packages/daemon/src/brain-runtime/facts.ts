import type { RunRegistry, RunRow } from "../run-registry.ts";

/**
 * What a settled run's finalize journal says, read once for everything that
 * must decide on it: `select_winner`'s validator and effect, and the group
 * settle pass. One reader, so the check that refuses a run and the effect
 * that merges one cannot disagree (design I1, I2).
 */

export interface RunFacts {
	run: RunRow | null;
	/** The run ended and its finalize reached a terminal state. */
	settled: boolean;
	/** The deterministic checks passed (or none were configured and it exited 0). */
	verified: boolean;
	verifyRan: boolean;
	/** Files changed outside the task's own `owns`; 0 when no scope was declared. */
	scopeOutside: number;
	/** The review floor's verdict, when a critic ran. */
	review: { status: "ok" | "failed"; verdict: string | null } | null;
}

const TERMINAL = new Set([
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);

export async function runFacts(
	registry: Pick<RunRegistry, "get" | "steps">,
	runId: string,
	opts: { hasChecks: boolean },
): Promise<RunFacts> {
	const run = await registry.get(runId);
	if (!run) {
		return {
			run: null,
			settled: false,
			verified: false,
			verifyRan: false,
			scopeOutside: 0,
			review: null,
		};
	}
	const steps = await registry.steps(runId);
	const done = (name: string) =>
		steps.find((s) => s.step === name && s.status === "done")?.result as
			| Record<string, unknown>
			| undefined;
	const verify = done("verify");
	const scope = done("scope_check");
	const critic = done("critic");
	const exited = run.state === "completed" && (run.exitCode ?? 0) === 0;
	return {
		run,
		settled: TERMINAL.has(run.state) || run.state === "merging",
		verified: verify ? verify.passed === true : !opts.hasChecks && exited,
		verifyRan: verify !== undefined,
		scopeOutside:
			scope && typeof scope.outside === "number" ? scope.outside : 0,
		review: critic
			? {
					status: critic.status === "ok" ? "ok" : "failed",
					verdict:
						typeof critic.verdict === "string"
							? (critic.verdict as string)
							: null,
				}
			: null,
	};
}
