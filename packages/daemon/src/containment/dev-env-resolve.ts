/**
 * What a run of a project gets for its dev environment, decided once from the
 * owner's approval and the project's integrated base (design "Dev environment
 * runs inside the sandbox"): nothing (no environment declared), the cached
 * evaluation of the approved commit, or a refusal that says exactly what to
 * do. Never a run without the environment the project declares.
 *
 * The environment is always the approved one. A candidate that edits `.envrc`
 * is checked with the approved environment, not its own: that edit is
 * evaluated only once the owner allows the commit it lands in.
 */

import { join } from "node:path";
import {
	type BuildDevEnvInput,
	buildDevEnv,
	DevEnvBuildError,
	type DevEnvCapture,
	loadDevEnv,
} from "./dev-env-cache.ts";
import type { EnvConfig } from "./dev-env-config.ts";
import { EnvSourceError, resolveCommit } from "./dev-env-sources.ts";
import { type EnvStatus, EnvTrustStore, envStatusAt } from "./dev-env-trust.ts";

export type DevEnvRefusalCode =
	| "env_unsupported"
	| "env_not_approved"
	| "env_denied"
	| "env_drifted"
	| "env_not_built"
	| "env_build_failed";

export type DevEnvResolution =
	| { kind: "none" }
	| { kind: "ready"; capture: DevEnvCapture; fingerprint: string }
	| {
			kind: "refused";
			code: DevEnvRefusalCode;
			reason: string;
			fix: string;
			/** The commit the decision was made on. */
			commit: string | null;
			/** The evaluation's log tail, for a failed build. */
			log?: string;
			status?: EnvStatus;
	  };

export interface ResolveDevEnvInput {
	mfwHome: string;
	project: string;
	/** The primary checkout's real path. */
	root: string;
	stateDir?: string;
	config: EnvConfig | undefined;
	/** The base runs start from: the integration branch, or a commit. */
	rev: string;
	/** Evaluate when the approval has no cached result yet. */
	build: boolean;
	seams?: Partial<
		Pick<BuildDevEnvInput, "run" | "steps" | "nixTrust" | "closure" | "gcRoots">
	>;
}

const shortSha = (s: string) => s.slice(0, 12);

export async function resolveDevEnv(
	input: ResolveDevEnvInput,
): Promise<DevEnvResolution> {
	let commit: string;
	try {
		commit = await resolveCommit(input.root, input.rev);
	} catch (err) {
		if (!(err instanceof EnvSourceError)) throw err;
		return {
			kind: "refused",
			code: "env_unsupported",
			reason: `cannot read the base ${input.rev}: ${err.message}`,
			fix: err.fix,
			commit: null,
		};
	}
	const store = new EnvTrustStore(input.mfwHome);
	let status: EnvStatus;
	try {
		status = await envStatusAt({
			store,
			root: input.root,
			commit,
			setting: input.config?.source ?? "auto",
			config: input.config,
		});
	} catch (err) {
		if (!(err instanceof EnvSourceError)) throw err;
		return {
			kind: "refused",
			code: "env_unsupported",
			reason: err.message,
			fix: err.fix,
			commit,
		};
	}
	const allow = `mfw env allow ${input.project} --rev ${commit}`;
	switch (status.state) {
		case "none":
			return { kind: "none" };
		case "unsupported":
			return {
				kind: "refused",
				code: "env_unsupported",
				reason: status.reason,
				fix: status.fix,
				commit,
				status,
			};
		case "not_approved":
			return {
				kind: "refused",
				code: "env_not_approved",
				reason: `the ${status.detection.kind} environment of ${input.project} at ${shortSha(commit)} is not approved (${status.detection.files.map((f) => f.path).join(", ")})`,
				fix: `review those files at ${shortSha(commit)}, then run \`${allow}\` or approve the card in the inbox`,
				commit,
				status,
			};
		case "denied":
			return {
				kind: "refused",
				code: "env_denied",
				reason: `the owner denied the environment of ${input.project}`,
				fix: `run \`${allow}\` to approve it`,
				commit,
				status,
			};
		case "drifted":
			return {
				kind: "refused",
				code: "env_drifted",
				reason: `the environment of ${input.project} changed since the approved commit ${shortSha(status.record.commit)}: ${[
					...status.changed,
					...(status.configChanged ? ["the project's env config"] : []),
				].join(", ")}`,
				fix: `review the change, then run \`${allow}\` or approve the card in the inbox`,
				commit,
				status,
			};
		case "approved":
			break;
	}
	const cached = await loadDevEnv(
		input.mfwHome,
		input.root,
		status.fingerprint,
	);
	if (cached)
		return { kind: "ready", capture: cached, fingerprint: status.fingerprint };
	if (!input.build) {
		return {
			kind: "refused",
			code: "env_not_built",
			reason: `the approved environment of ${input.project} has not been evaluated yet`,
			fix: `run \`mfw env build ${input.project}\`, or let the next dispatch build it`,
			commit,
			status,
		};
	}
	try {
		const capture = await buildDevEnv({
			mfwHome: input.mfwHome,
			root: input.root,
			stateDir: input.stateDir ?? join(input.root, ".mfw"),
			record: status.record,
			config: input.config,
			store,
			...(input.seams ?? {}),
		});
		return { kind: "ready", capture, fingerprint: status.fingerprint };
	} catch (err) {
		if (!(err instanceof DevEnvBuildError)) throw err;
		return {
			kind: "refused",
			code: "env_build_failed",
			reason: `evaluating the environment of ${input.project} at ${shortSha(status.record.commit)} failed: ${err.message}`,
			fix: err.fix,
			commit,
			log: err.log,
			status,
		};
	}
}
