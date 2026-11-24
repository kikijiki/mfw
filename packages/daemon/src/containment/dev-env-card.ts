/**
 * The ask-first card for a project's dev environment (decision rights, the
 * B5 card mechanism): raised when a dispatch finds the environment at the
 * integrated base not approved, or changed since the approval. It shows
 * exactly the commit and every file and hash approving it records, and
 * approving it is the same gesture as `mfw env allow --rev <commit>`.
 *
 * Approval is bound to that content: when the owner says yes, the files at
 * the card's commit are hashed again, and the card fails as stale unless they
 * are byte for byte what it showed. A decline denies the environment.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { brainActions } from "@mfw/db/schema";
import type { EnvConfig } from "./dev-env-config.ts";
import { type ApprovalPlan, planLines } from "./dev-env-plan.ts";
import type { DevEnvResolution } from "./dev-env-resolve.ts";
import {
	allowEnv,
	denyEnv,
	EnvTrustStore,
	envConfigHash,
	proposeApproval,
} from "./dev-env-trust.ts";

/**
 * What an approved evaluation can reach, said plainly. With the nix daemon
 * it is not contained by the proxy: the card and `mfw env allow` say so.
 */
export function envReachStatement(source: string, nixDaemon: boolean): string {
	const proxied =
		"Inside the env-build sandbox its own commands reach the network only through the run's proxy, which allows the listed hosts.";
	if (!nixDaemon) {
		return `${proxied} It gets no nix daemon (env.nixDaemon is off).`;
	}
	return `${proxied} It ALSO gets the host's nix daemon (env.nixDaemon is on)${source === "mise" ? "" : ", which this source uses"}: the daemon fetches and builds with this host's network, OUTSIDE the proxy, can reach this machine's loopback services, can read the whole Nix store (other projects' sources included), and can collect store paths that no root holds. Approve only a project you trust that far.`;
}

/** `brain_actions.tool` of the card. Not an act tool: the brain cannot call it. */
export const ENV_ALLOW_TOOL = "env_allow";

export interface EnvCardArgs {
	project: string;
	commit: string;
	source: string;
	files: { path: string; sha256: string }[];
	/** For a drift: what changed since the approved commit. */
	changed?: string[];
	previousCommit?: string;
	setup?: string[];
	configHash: string;
	/** The project's `env.nixDaemon` opt-in, shown prominently. */
	nixDaemon: boolean;
	/** What the owner reads: the whole-tree diff, or the files that shape it. */
	plan?: ApprovalPlan;
}

const digest = (args: Pick<EnvCardArgs, "commit" | "files" | "configHash">) =>
	createHash("sha256")
		.update(
			[
				args.commit,
				args.configHash,
				...args.files.map((f) => `${f.path}\0${f.sha256}`),
			].join("\n"),
		)
		.digest("hex")
		.slice(0, 32);

/** The card's arguments for a refusal the owner can answer, or null for any other. */
export function envCardArgs(
	project: string,
	config: EnvConfig | undefined,
	r: DevEnvResolution,
): EnvCardArgs | null {
	if (r.kind !== "refused" || !r.commit || !r.status) return null;
	const s = r.status;
	if (s.state !== "not_approved" && s.state !== "drifted") return null;
	const kind = s.detection.kind;
	return {
		project,
		commit: r.commit,
		source:
			kind === "none" ? "setup" : kind === "unsupported" ? "unsupported" : kind,
		files: s.detection.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
		...(s.state === "drifted"
			? { changed: s.changed, previousCommit: s.record.commit }
			: {}),
		...(config?.setup?.length ? { setup: [...config.setup] } : {}),
		configHash: envConfigHash(config),
		nixDaemon: config?.nixDaemon === true,
	};
}

/**
 * Raise the card once per commit and content: the idempotency key carries
 * both, so a dispatch that keeps being refused does not pile up cards.
 */
export async function raiseEnvCard(
	handle: ProjectDbHandle,
	bus: EventBus,
	args: EnvCardArgs,
	now: () => Date = () => new Date(),
): Promise<boolean> {
	const actionId = ulid();
	const stored = await handle.withTx(async (tx) => {
		const inserted = await tx
			.insert(brainActions)
			.values({
				id: actionId,
				idemKey: `env_allow:${digest(args)}`,
				sessionId: "dev-env",
				turnRunId: `env-${args.commit.slice(0, 12)}`,
				tool: ENV_ALLOW_TOOL,
				args: args as unknown as Record<string, unknown>,
				status: "held",
				effects: {
					rights: {
						actionClass: "host_executed_merge",
						cause: "default",
						classes: ["host_executed_merge"],
					},
				},
				createdAt: now(),
			})
			.onConflictDoNothing()
			.returning({ id: brainActions.id });
		if (inserted.length === 0) return null;
		return appendEvent(tx, {
			type: "brain.action",
			payload: {
				actionId,
				tool: ENV_ALLOW_TOOL,
				status: "held",
				sessionId: "dev-env",
			},
		});
	});
	if (stored) bus.publish([stored]);
	return stored !== null;
}

/** The card's text: what approving records, file by file. */
export function describeEnvCard(raw: Record<string, unknown>): {
	title: string;
	detail: string;
} {
	const a = raw as unknown as EnvCardArgs;
	const files = Array.isArray(a.files)
		? a.files
				.map((f) => `${f.path} (sha256 ${String(f.sha256).slice(0, 16)}…)`)
				.join(", ")
		: "";
	const changed =
		Array.isArray(a.changed) && a.changed.length
			? ` Changed since the approved commit ${String(a.previousCommit ?? "").slice(0, 12)}: ${a.changed.join(", ")}.`
			: "";
	const setup =
		Array.isArray(a.setup) && a.setup.length
			? ` Setup commands: ${a.setup.map((c) => JSON.stringify(c)).join(", ")}.`
			: "";
	const plan = a.plan ? ` ${planLines(a.plan).join("\n").slice(0, 6000)}` : "";
	return {
		title: `decide: dev environment of ${a.project} at ${String(a.commit).slice(0, 12)}`,
		detail: `${a.nixDaemon === true ? "NIX DAEMON: ON. " : ""}Approving lets mfw evaluate this ${a.source} environment, once, at commit ${a.commit}, and give the result to every run. ${envReachStatement(String(a.source), a.nixDaemon === true)} It records these files: ${files}.${changed}${setup} Declining refuses the project's runs until \`mfw env allow\`.${plan}`,
	};
}

/**
 * Carry out the owner's answer. Approve: only if the files at the card's
 * commit are still exactly the ones shown.
 */
export async function applyEnvCard(
	input: {
		mfwHome: string;
		root: string;
		config: EnvConfig | undefined;
	},
	raw: Record<string, unknown>,
	approved: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const a = raw as unknown as EnvCardArgs;
	const root = realpathSync(input.root);
	const store = new EnvTrustStore(input.mfwHome);
	if (!approved) {
		await denyEnv(store, {
			project: a.project,
			root,
			commit: a.commit,
			config: input.config,
			via: "card",
		});
		return { ok: true };
	}
	const setting = input.config?.source ?? "auto";
	const { detection, configHash } = await proposeApproval({
		project: a.project,
		root,
		commit: a.commit,
		setting,
		config: input.config,
	});
	const now = detection.files.map((f) => `${f.path}\0${f.sha256}`).join("\n");
	const shown = (a.files ?? []).map((f) => `${f.path}\0${f.sha256}`).join("\n");
	if (now !== shown || configHash !== a.configHash) {
		return {
			ok: false,
			message:
				"the environment files or the project's env config changed since this card was raised; the next dispatch raises a new card",
		};
	}
	await allowEnv(store, {
		project: a.project,
		root,
		commit: a.commit,
		setting,
		config: input.config,
		via: "card",
	});
	return { ok: true };
}
