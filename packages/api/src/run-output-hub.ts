/**
 * One reader per run for `live.runOutput` (tail fan-out).
 *
 * A run can be visible in a card, the Story and Home at once, and each view
 * opens its own `live.runOutput` stream. Without this every stream polled the
 * file itself. The hub keeps ONE poller per (registry, run, file) that appends
 * what the file grew by to a bounded in-memory window; each subscriber serves
 * itself from that window by byte offset. A subscriber that is behind the
 * window (a fresh stream from offset 0 of a long transcript) catches up with
 * direct reads, then joins.
 *
 * The window is process memory only; nothing is persisted and the file stays
 * the source of truth.
 */

export type OutputFile = "events.jsonl" | "raw.log";

export interface OutputSource {
	readOutput(
		runId: string,
		file: OutputFile,
		offset: number,
	): Promise<{ chunk: string; size: number; complete: boolean }>;
	get(runId: string): Promise<{ state: string } | null | undefined>;
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

/** Window size: the newest this many bytes stay buffered. */
const WINDOW_BYTES = 4 * 1024 * 1024;
const POLL_MS = 500;

interface Piece {
	start: number;
	end: number;
	text: string;
}

export class RunOutputHub {
	private pieces: Piece[] = [];
	private refs = 0;
	private listeners = new Set<() => void>();
	private polling = false;
	private sleeper: (() => void) | null = null;
	private stopped = false;
	/** Terminal state once the run ended and its output was drained. */
	ended: string | null = null;
	error: unknown = null;
	/** Offset of the first buffered byte. */
	base: number;
	/** Offset just past the last buffered byte. */
	end: number;

	constructor(
		private readonly source: OutputSource,
		readonly runId: string,
		readonly file: OutputFile,
		startOffset: number,
		private readonly onIdle: () => void,
		private readonly pollMs = POLL_MS,
	) {
		this.base = startOffset;
		this.end = startOffset;
	}

	acquire(): void {
		this.refs++;
		if (!this.polling) {
			this.polling = true;
			this.stopped = false;
			void this.poll();
		}
	}

	release(): void {
		this.refs--;
		if (this.refs <= 0) {
			this.stopped = true;
			this.sleeper?.();
			this.wake();
			this.onIdle();
		}
	}

	/** Chunks that begin exactly at `offset`, contiguous to the window's end; null when `offset` is not a boundary in the window. */
	from(offset: number): Piece[] | null {
		if (offset >= this.end || offset < this.base) return null;
		const i = this.pieces.findIndex((p) => p.start === offset);
		return i < 0 ? null : this.pieces.slice(i);
	}

	/** Resolves on the next poller tick, an abort, or after `timeoutMs`. */
	changed(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal?.aborted || this.stopped) return resolve();
			const done = () => {
				clearTimeout(timer);
				this.listeners.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			this.listeners.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	private wake(): void {
		for (const l of [...this.listeners]) l();
	}

	private push(piece: Piece): void {
		this.pieces.push(piece);
		this.end = piece.end;
		while (this.pieces.length > 1 && this.end - this.base > WINDOW_BYTES) {
			const dropped = this.pieces.shift() as Piece;
			this.base = dropped.end;
		}
	}

	private async poll(): Promise<void> {
		let terminalState: string | null = null;
		try {
			while (!this.stopped) {
				const { chunk, size, complete } = await this.source.readOutput(
					this.runId,
					this.file,
					this.end,
				);
				if (chunk.length > 0 && size > this.end) {
					this.push({ start: this.end, end: size, text: chunk });
					this.wake();
				}
				// Drain a capped backlog before looking at the run's state.
				if (!complete) continue;
				if (terminalState !== null && chunk.length === 0) {
					this.ended = terminalState;
					this.wake();
					return;
				}
				const run = await this.source.get(this.runId);
				if (!run || TERMINAL.has(run.state)) {
					// One more read: output written between the last read and the state check.
					terminalState = run?.state ?? "unknown";
					continue;
				}
				await new Promise<void>((resolve) => {
					const done = () => {
						clearTimeout(timer);
						this.sleeper = null;
						resolve();
					};
					const timer = setTimeout(done, this.pollMs);
					this.sleeper = done;
				});
			}
		} catch (e) {
			this.error = e;
			this.wake();
		} finally {
			this.polling = false;
		}
	}
}

const hubs = new WeakMap<object, Map<string, RunOutputHub>>();

/** The shared hub for a run's file, created at `startOffset` by the first subscriber. */
export function hubFor(
	source: OutputSource,
	runId: string,
	file: OutputFile,
	startOffset: number,
	pollMs?: number,
): RunOutputHub {
	let byKey = hubs.get(source);
	if (!byKey) {
		byKey = new Map();
		hubs.set(source, byKey);
	}
	const key = `${runId}\0${file}`;
	let hub = byKey.get(key);
	if (!hub) {
		const map = byKey;
		hub = new RunOutputHub(
			source,
			runId,
			file,
			startOffset,
			() => {
				if (map.get(key) === hub) map.delete(key);
			},
			pollMs,
		);
		byKey.set(key, hub);
	}
	return hub;
}
