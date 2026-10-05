import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { printDocument } from "@mfw/board-core";
import { claimTask, releaseClaim, TaskOwnershipHeldError } from "../claim.ts";
import { CliError, type Command, UsageError } from "./types.ts";

/** The cwd's git toplevel if any, else the cwd. */
function defaultWorktree(): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	const top = r.status === 0 ? r.stdout.trim() : "";
	return top || process.cwd();
}

export const claim: Command = {
	name: "claim",
	usage: [
		"claim <id> [--run <runId>] [--worktree <path>] [--lease-ms <n>] [--from <status>]",
	],
	async run(ctx, args) {
		const id = args.positional[0];
		if (!id) throw new UsageError();
		const run = args.run ?? `run-${randomUUID()}`;
		try {
			const doc = await claimTask(
				ctx.project.store,
				id,
				run,
				args.leaseMs ?? 15 * 60_000,
				args.from ?? "ready",
				ctx.project.claim,
				{ start: false, worktree: args.worktree ?? defaultWorktree() },
			);
			if (!doc) {
				throw new CliError(
					`${id} could not be claimed (not ready, already claimed, or a dependency is unfinished)`,
				);
			}
			printDocument(doc);
			console.log(`run: ${run}`);
		} catch (e) {
			if (e instanceof TaskOwnershipHeldError) throw new CliError(e.message);
			throw e;
		}
	},
};

export const release: Command = {
	name: "release",
	usage: ["release <id> --run <runId>"],
	async run(ctx, args) {
		const id = args.positional[0];
		if (!id || !args.run) throw new UsageError();
		const doc = await releaseClaim(
			ctx.project.store,
			id,
			args.run,
			null,
			ctx.project.claim,
		);
		if (!doc) throw new CliError(`${id} is held by a different run`);
		printDocument(doc);
	},
};
