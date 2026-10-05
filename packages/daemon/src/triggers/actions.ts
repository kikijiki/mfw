import type { TriggerAction, TriggerDef } from "./def.ts";
import type { TriggerEvent } from "./events.ts";

/**
 * The seam actions plug into (§8). Deliberately narrow: one call, one terminal
 * result. Handlers get no access to the cursor, deliveries table or loader, so
 * they cannot misreport whether they ran.
 */

export interface TriggerDispatch {
	def: TriggerDef;
	/** First 16 hex of `sha256(defId + ":" + seq)`; idempotency key, stable across replays. */
	deliveryId: string;
	/** Real event for `on:` triggers; synthetic tick (`cronTickEvent`) for `cron:` ones. */
	event: TriggerEvent;
	/** Absolute path to the project's primary checkout. */
	projectRoot: string;
	projectName: string;
	/** Secret names the arming record granted. A requested name missing here must refuse dispatch, never resolve to "" (§3.5 M3). */
	grantedSecrets: readonly string[];
	/** Seqs a coalescing catch-up skipped to reach this one. */
	skippedSeqs: readonly number[];
}

export interface TriggerActionResult {
	ok: boolean;
	/** Stored in the delivery row: stderr tail, agent summary, failure reason. */
	detail?: string;
	exitCode?: number;
	/** Set by the agent action, so a delivery links to the run it started. */
	runId?: string;
}

export type TriggerActionHandler = (
	dispatch: TriggerDispatch,
) => Promise<TriggerActionResult>;

export type TriggerActionKind = TriggerAction["kind"];

/** Kind → handler. A kind with no handler fails dispatch with a named reason, never a silent success. */
export class TriggerActionRegistry {
	private readonly handlers = new Map<
		TriggerActionKind,
		TriggerActionHandler
	>();

	register(kind: TriggerActionKind, handler: TriggerActionHandler): this {
		this.handlers.set(kind, handler);
		return this;
	}

	has(kind: TriggerActionKind): boolean {
		return this.handlers.has(kind);
	}

	async run(dispatch: TriggerDispatch): Promise<TriggerActionResult> {
		const kind = dispatch.def.action.kind;
		const handler = this.handlers.get(kind);
		if (!handler) {
			return {
				ok: false,
				detail: `no handler registered for action kind "${kind}"`,
			};
		}
		return handler(dispatch);
	}
}

/** Placeholder that succeeds without side effects. Tests only; `boot.ts` must not register it. */
export const noopAction: TriggerActionHandler = async (dispatch) => ({
	ok: true,
	detail: `no-op placeholder for ${dispatch.def.action.kind}`,
});
