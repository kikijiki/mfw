import { mutateConfig } from "./config.ts";
import type { GlobalDispatchStore } from "./dispatch.ts";

/**
 * The machine-wide master stop, backed by `dispatchPaused` in config.json.
 *
 * Read on every scheduler tick, so the value lives in memory (a disk read could
 * fail open, which a stop switch must never do). The in-memory value updates
 * only after the config write lands, so a failed write leaves daemon and file
 * agreeing.
 */
export class GlobalDispatch implements GlobalDispatchStore {
	private value: { reason: string } | null;

	private constructor(
		initial: { reason: string } | null,
		private readonly mfwHome: string,
	) {
		this.value = initial;
	}

	/** Build from an already-loaded config, so boot does not read it twice. */
	static from(
		cfg: { dispatchPaused?: boolean },
		reason: string,
		mfwHome: string,
	): GlobalDispatch {
		return new GlobalDispatch(
			cfg.dispatchPaused === true ? { reason } : null,
			mfwHome,
		);
	}

	paused(): { reason: string } | null {
		return this.value;
	}

	/** Passed to schedulers as `globalPaused`; an arrow so it keeps `this`. */
	readonly gate = (): { reason: string } | null => this.value;

	async setPaused(next: { reason: string } | null): Promise<void> {
		await mutateConfig(this.mfwHome, (config) => {
			if (next) config.dispatchPaused = true;
			else delete config.dispatchPaused;
		});
		this.value = next;
	}
}
