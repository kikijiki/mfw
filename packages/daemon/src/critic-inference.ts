import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { assertModelId } from "@mfw/core/model-id";
import type { ProviderConfig } from "./agents/adapter.ts";
import {
	type InferenceClient,
	type InferenceOpts,
	type InferenceReply,
	inferenceForProvider,
	parseClaudeReply,
} from "./brain.ts";
import type { LauncherSteps } from "./containment/agent-launch.ts";
import { runOneShotAgent } from "./containment/oneshot-agent.ts";
import { createEmptyRoleTree } from "./run-workspace/role-clone.ts";

/**
 * The critic reads agent-written diffs, so its model runs like any other
 * agent: through the attested reviewer launch, with no tools, in an empty tree
 * and with no view of the project. Only Claude has a one-shot mode with its
 * tools really off. Codex's keeps a shell and an ACP agent may read unasked,
 * so both are refused until they have a sandboxed route; a refused critic is a
 * failed review, which sends the task to a person.
 */

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface CriticHost {
	projectRoot: string;
	mfwHome: string;
	stateDir: string;
	bin?: string;
	/** Test seam: the sandboxed launch. */
	launch?: typeof runOneShotAgent;
	/** Test seam: the launcher's host steps. */
	steps?: LauncherSteps;
}

export class CriticTransportRefused extends Error {
	constructor(providerId: string) {
		super(
			`the critic cannot run on '${providerId}': this transport has no sandboxed no-tools mode, so it could read this machine while judging agent-written text. ` +
				'Fix: use Claude Code or an OpenAI-compatible endpoint for this project, or set assistance.changeReview to "off". This task goes to human review.',
		);
		this.name = "CriticTransportRefused";
	}
}

export class SandboxedCriticInference implements InferenceClient {
	constructor(private readonly host: CriticHost) {}

	async complete(prompt: string, opts: InferenceOpts): Promise<InferenceReply> {
		assertModelId(opts.model);
		const empty = await createEmptyRoleTree(
			this.host.projectRoot,
			`critic-${randomUUID()}`,
		);
		try {
			const r = await (this.host.launch ?? runOneShotAgent)({
				role: "reviewer",
				cli: "claude",
				tree: empty.tree,
				projectRoot: this.host.projectRoot,
				stateDir: this.host.stateDir,
				mfwHome: this.host.mfwHome,
				// The prompt travels on stdin.
				argv: [
					this.host.bin ?? "claude",
					"-p",
					"--model",
					opts.model,
					"--output-format",
					"json",
					"--tools",
					"",
					"--strict-mcp-config",
					"--no-session-persistence",
				],
				prompt,
				timeoutMs: opts.timeoutMs,
				maxOutputBytes: MAX_OUTPUT_BYTES,
				...(opts.signal ? { signal: opts.signal } : {}),
				...(this.host.steps ? { steps: this.host.steps } : {}),
			});
			if (r.timedOut) throw new Error("critic timed out");
			if (opts.signal?.aborted) throw new Error("critic aborted");
			if (r.exitCode !== 0) {
				throw new Error(
					`critic failed (${r.exitCode ?? "signal"}): ${
						r.stderr.trim().slice(-400) ||
						r.stdout.trim().slice(-400) ||
						"no output"
					}`,
				);
			}
			return parseClaudeReply(r.stdout);
		} finally {
			await rm(empty.root, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}
}

/** The critic's transport for a provider without an HTTP endpoint. */
export function criticInferenceFor(
	provider: ProviderConfig,
	host: CriticHost,
): InferenceClient {
	switch (provider.type) {
		case "claude-cli":
			return new SandboxedCriticInference(host);
		case "codex-cli":
		case "acp":
			return {
				complete: async () => {
					throw new CriticTransportRefused(provider.id);
				},
			};
		default:
			// Its own call-time refusal: no non-interactive transport.
			return inferenceForProvider(provider);
	}
}
