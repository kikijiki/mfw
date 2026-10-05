import { dirname } from "node:path";
import {
	applyTransition,
	ChildrenOpenError,
	documentToJson,
	printDocument,
	statusClassOf,
	TransitionArgError,
	TransitionPreconditionError,
	type TransitionSpec,
	UnknownTransitionError,
} from "@mfw/board-core";
import { withClaimLock } from "../claim.ts";
import {
	commitFile,
	commitMessage,
	GitError,
	isInsideWorkTree,
	push,
} from "../git.ts";
import type { MfwProject } from "../project.ts";
import { clearLease } from "../state.ts";
import { CliError, type Command, UsageError } from "./types.ts";

/** Every `[type, spec]` declaring `verb` on this board. */
export function typesDeclaring(
	project: MfwProject,
	verb: string,
): [string, TransitionSpec][] {
	const out: [string, TransitionSpec][] = [];
	for (const [name, t] of Object.entries(project.config.types)) {
		const spec = t.workflow?.transitions[verb];
		if (spec) out.push([name, spec]);
	}
	return out;
}

/** Usage lines for every declared verb (deduped by identical form). */
export function transitionUsage(project: MfwProject): string[] {
	const lines = new Map<string, string[]>();
	const multi = Object.keys(project.config.types).length > 1;
	for (const [typeName, t] of Object.entries(project.config.types)) {
		for (const [verb, s] of Object.entries(t.workflow?.transitions ?? {})) {
			const text = s.arg ? ` <${s.arg}>` : "";
			const line = `${verb} <id>${text} [--type <type>] [--date YYYY-MM-DD] [--commit] [--push]   ${s.from.join("|")} -> ${s.to}${s.arg ? " (takes text)" : ""}`;
			const key = line;
			const types = lines.get(key) ?? [];
			types.push(typeName);
			lines.set(key, types);
		}
	}
	return [...lines].map(
		([line, types]) => `${line}${multi ? `   [${types.join(", ")}]` : ""}`,
	);
}

function transitionCommand(verb: string): Command {
	return {
		name: verb,
		usage: [`${verb} <id> [<text>]`],
		async run(ctx, args) {
			const { project } = ctx;
			const declaring = typesDeclaring(project, verb);
			let type: string;
			if (args.type !== undefined) {
				if (!(args.type in project.config.types)) {
					throw new CliError(
						`unknown type '${args.type}' (board types: ${Object.keys(project.config.types).join(", ")})`,
					);
				}
				if (!declaring.some(([t]) => t === args.type)) {
					throw new CliError(
						`type '${args.type}' does not declare the '${verb}' transition (declared by: ${declaring.map(([t]) => t).join(", ") || "no type"})`,
						2,
					);
				}
				type = args.type;
			} else if (declaring.length === 1) {
				type = (declaring[0] as [string, TransitionSpec])[0];
			} else if (declaring.length === 0) {
				throw new UsageError();
			} else {
				// Several types declare the verb: the id says which document is meant.
				const wanted = args.rest[0];
				const hits: string[] = [];
				if (wanted) {
					for (const [t] of declaring) {
						if (await project.store.readDocument(t, wanted)) hits.push(t);
					}
				}
				if (hits.length === 1) type = hits[0] as string;
				else if (hits.length > 1) {
					throw new CliError(
						`'${wanted}' exists in several types that declare '${verb}' (${hits.join(", ")}); pass --type <type>`,
						2,
					);
				} else {
					throw new CliError(
						wanted
							? `no document '${wanted}' in the types that declare '${verb}' (${declaring.map(([t]) => t).join(", ")})`
							: `usage: mfwb ${verb} <id> [<text>]`,
						wanted ? 1 : 2,
					);
				}
			}
			const [id, ...rest] = args.rest;
			if (!id || rest.length > 1) {
				throw new CliError(
					`usage: mfwb ${verb} <id> [<text>] [--type <type>] [--date YYYY-MM-DD] [--commit] [--push] (quote text that has spaces)`,
					2,
				);
			}
			const text = rest[0];

			let doc: Awaited<ReturnType<typeof applyTransition>>;
			try {
				const to = (
					declaring.find(([t]) => t === type) as [string, TransitionSpec]
				)[1].to;
				const cls = statusClassOf(project.config, type, to);
				// Same lock as `claim`, so a transition and a claim cannot interleave.
				// Reaching a terminal or parked status releases the CLI claim binding;
				// otherwise a daemon's lease-expiry sweep would act on a finished task.
				doc = await withClaimLock(project.claim, async () => {
					const applied = await applyTransition(
						project.store,
						project.config,
						type,
						id,
						verb,
						text,
						args.date === undefined ? {} : { date: args.date },
					);
					if (cls === "terminal" || cls === "parked") {
						await clearLease(project.root, id);
					}
					return applied;
				});
			} catch (e) {
				if (e instanceof TransitionPreconditionError) {
					throw new CliError(
						`${type} ${e.id}: expected status ${e.from.join(" or ")}, got ${e.actual}`,
					);
				}
				if (e instanceof ChildrenOpenError) {
					throw new CliError(
						`${type} ${e.id}: open children block this transition: ${e.openChildIds.join(", ")}`,
					);
				}
				if (
					e instanceof UnknownTransitionError ||
					e instanceof TransitionArgError
				) {
					throw new CliError(e.message, 2);
				}
				throw e;
			}

			if (ctx.json) console.log(JSON.stringify(documentToJson(doc)));
			else printDocument(doc);

			if (args.commit || args.push) {
				const cwd = dirname(doc.path);
				const applied = `${type} ${id} was transitioned and ${doc.path} written, but`;
				if (!(await isInsideWorkTree(cwd))) {
					throw new CliError(
						`${applied} ${cwd} is not inside a git work tree, so nothing was committed`,
					);
				}
				const prefix =
					project.config.types[type]?.workflow?.commit.prefix ?? type;
				try {
					await commitFile(
						doc.path,
						commitMessage(prefix, id, verb, text),
						cwd,
					);
				} catch (e) {
					throw new CliError(`${applied} the commit failed: ${gitMsg(e)}`);
				}
				if (args.push) {
					try {
						await push(cwd);
					} catch (e) {
						throw new CliError(
							`${applied} the commit succeeded and git push failed: ${gitMsg(e)}`,
						);
					}
				}
			}
		},
	};
}

function gitMsg(e: unknown): string {
	return e instanceof GitError ? e.message : String(e);
}

/** The dynamic command for transition `verb`, if any type of the board declares it. */
export function lookupTransitionCommand(
	project: MfwProject,
	verb: string,
): Command | null {
	return typesDeclaring(project, verb).length > 0
		? transitionCommand(verb)
		: null;
}
