/**
 * The contract between the verifier and the sandbox that runs its checks. Kept
 * apart from check-sandbox.ts so the verifier does not load the launch path.
 */

import type { ProcResult } from "../proc.ts";
import type { VerifyRole } from "./role-profiles.ts";

/** The check did not run. This says nothing about the code under test. */
export class CheckSandboxRefusal extends Error {
	constructor(
		readonly code: string,
		reason: string,
		readonly fix: string,
	) {
		super(reason);
		this.name = "CheckSandboxRefusal";
	}
}

export interface CheckRunRequest {
	role: VerifyRole;
	/** The disposable clone's work tree. */
	tree: string;
	command: string;
	prefix?: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}

export type CheckRunner = (req: CheckRunRequest) => Promise<ProcResult>;

/** Drain a stream, keeping the last `max` bytes. */
export async function drainTail(
	stream: AsyncIterable<Uint8Array>,
	max: number,
): Promise<{ text: string; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let held = 0;
	let truncated = false;
	for await (const chunk of stream) {
		chunks.push(chunk);
		held += chunk.length;
		while (held > max && chunks.length > 1) {
			held -= (chunks.shift() as Uint8Array).length;
			truncated = true;
		}
	}
	let bytes = Buffer.concat(chunks);
	if (bytes.length > max) {
		bytes = bytes.subarray(bytes.length - max);
		truncated = true;
	}
	return { text: bytes.toString(), truncated };
}
