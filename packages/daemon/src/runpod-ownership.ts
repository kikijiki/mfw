import type { ExecutionOwnership } from "./execution-target.ts";

export const RUNPOD_OWNERSHIP_ENV = "MFW_RUNPOD_OWNERSHIP_V1";
export const RUNPOD_OWNERSHIP_VERSION = 1 as const;

export interface RunPodOwnershipMetadata {
	v: typeof RUNPOD_OWNERSHIP_VERSION;
	ns: string;
	account: string;
	project: string;
	run: string;
	task: string | null;
	attempt: number;
	owner: string;
	create: string;
	/** Random capability persisted before create; prevents prefix/name forgery. */
	nonce: string;
}

function isMetadata(value: unknown): value is RunPodOwnershipMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		v.v === RUNPOD_OWNERSHIP_VERSION &&
		typeof v.ns === "string" &&
		typeof v.account === "string" &&
		typeof v.project === "string" &&
		typeof v.run === "string" &&
		(v.task === null || typeof v.task === "string") &&
		typeof v.attempt === "number" &&
		Number.isInteger(v.attempt) &&
		v.attempt > 0 &&
		typeof v.owner === "string" &&
		typeof v.create === "string" &&
		typeof v.nonce === "string" &&
		/^[0-9a-f-]{36}$/.test(v.nonce)
	);
}

export function makeRunPodOwnership(
	namespace: string,
	accountId: string,
	owner: ExecutionOwnership,
	createOperationId: string,
	nonce: string,
): RunPodOwnershipMetadata {
	return {
		v: RUNPOD_OWNERSHIP_VERSION,
		ns: namespace,
		account: accountId,
		project: owner.projectId,
		run: owner.runId,
		task: owner.taskId,
		attempt: owner.attempt,
		owner: owner.ownerKey,
		create: createOperationId,
		nonce,
	};
}

export function encodeRunPodOwnership(
	metadata: RunPodOwnershipMetadata,
): string {
	return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
}

export function decodeRunPodOwnership(
	encoded: string | undefined,
): RunPodOwnershipMetadata | null {
	if (!encoded || encoded.length > 4096) return null;
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		);
		return isMetadata(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function sameRunPodOwnership(
	a: RunPodOwnershipMetadata,
	b: RunPodOwnershipMetadata,
): boolean {
	return (
		a.v === b.v &&
		a.ns === b.ns &&
		a.account === b.account &&
		a.project === b.project &&
		a.run === b.run &&
		a.task === b.task &&
		a.attempt === b.attempt &&
		a.owner === b.owner &&
		a.create === b.create &&
		a.nonce === b.nonce
	);
}
