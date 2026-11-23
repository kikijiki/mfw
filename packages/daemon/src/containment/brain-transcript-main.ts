/**
 * `brain-transcript-main.ts <turnState> <store> <cli>`: the end of a brain
 * turn's `run.sh`, after its sandbox has exited and before its clone is removed.
 * A failure leaves the earlier transcript, and the next `--resume` then starts
 * a fresh generation if it cannot use it.
 */

import { commitBrainTranscript } from "./brain-transcript.ts";

const [turnState, store, cli] = process.argv.slice(2);
if (!turnState || !store || (cli !== "claude" && cli !== "codex")) {
	process.exit(64);
}
await commitBrainTranscript(turnState, store, cli).catch(() => false);
