import type { Principal } from "@mfw/daemon/auth/service";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError, z } from "zod";

/**
 * The context carries the Orchestrator; `projectProcedure` resolves one
 * project's service bag. Domain errors map to typed tRPC codes in one
 * middleware so the UI can branch on `code`.
 */

export interface Context {
	orchestrator: Orchestrator;
	/** Who is calling. Null means unauthenticated, and every procedure refuses it. */
	principal: Principal | null;
}

function refusalFix(
	cause: unknown,
): { kind: "setting" | "command" | "ui"; text: string } | null {
	const fix = (cause as { fix?: unknown } | undefined)?.fix as
		| { kind?: unknown; text?: unknown }
		| undefined;
	if (!fix || typeof fix.text !== "string" || fix.text.length === 0)
		return null;
	const kind =
		fix.kind === "setting" || fix.kind === "command" ? fix.kind : "ui";
	return { kind, text: fix.text };
}

const t = initTRPC.context<Context>().create({
	transformer: superjson,
	errorFormatter({ shape, error }) {
		return {
			...shape,
			data: {
				...shape.data,
				zodError:
					error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
				// A refusal's exact remedy (`{kind, text}`), when the daemon gave one.
				fix: refusalFix(error.cause),
				// The daemon error class (e.g. `TaskUnmergedError`), so a screen can
				// offer the matching follow-up action without parsing the message.
				domainError:
					error.cause?.name && error.cause.name in ERROR_CODES
						? error.cause.name
						: null,
			},
		};
	},
});

/** Domain errors the daemon throws, mapped to transport codes in one place. */
const ERROR_CODES: Record<string, TRPCError["code"]> = {
	ConflictError: "CONFLICT",
	SpecConflictError: "CONFLICT",
	AdrConflictError: "CONFLICT",
	AdrImmutableError: "PRECONDITION_FAILED",
	AdrTransitionError: "PRECONDITION_FAILED",
	AdrNotFoundError: "NOT_FOUND",
	// Refused spec/attachment (too big, bad name).
	ExtrasError: "BAD_REQUEST",
	SteerUnsupportedError: "PRECONDITION_FAILED",
	// PRECONDITION_FAILED, not CONFLICT: not a stale-rev race, the live run must be dealt with first.
	TaskClaimedError: "PRECONDITION_FAILED",
	MalformedTaskFileError: "PRECONDITION_FAILED",
	HumanInProgressError: "PRECONDITION_FAILED",
	DraftStatusError: "PRECONDITION_FAILED",
	DraftAwaitingAnswersError: "PRECONDITION_FAILED",
	ClarificationContinuationClaimedError: "PRECONDITION_FAILED",
	ClarificationConflictError: "CONFLICT",
	// Run reached the server despite the UI disabling it (e.g. master stop flipped mid-click).
	GlobalStopError: "PRECONDITION_FAILED",
	RunPodControlPlaneError: "PRECONDITION_FAILED",
	TaskNotClaimableError: "PRECONDITION_FAILED",
	TriggerReviewStaleError: "PRECONDITION_FAILED",
	// The remedy is in `data.fix`: stop the run / merge or discard the branch.
	RunLiveError: "PRECONDITION_FAILED",
	TaskUnmergedError: "PRECONDITION_FAILED",
	// A board `error` rule refused the write; the message lists each violation.
	RuleViolationError: "PRECONDITION_FAILED",
	// A checklist selector matched nothing or several items, or empty text.
	FieldOpError: "BAD_REQUEST",
	// Settings would pair a reviewer with an equal worker; the message has the fix.
	ReviewIndependenceError: "BAD_REQUEST",
	// A doc source that leaves the repository or board folder, or repeats an id.
	DocSourceError: "BAD_REQUEST",
	NotFoundError: "NOT_FOUND",
	// A ref name or path that cannot be one (leading `-`, control characters, `..`).
	InvalidRefError: "BAD_REQUEST",
	// An act tool outside a live brain turn, or a read the brain may not make.
	BrainActionError: "PRECONDITION_FAILED",
	BrainReadError: "BAD_REQUEST",
	// A person's override of a brain decision that cannot be applied (already overridden, no reason, a step refused).
	OverrideError: "PRECONDITION_FAILED",
	HostNotFoundError: "NOT_FOUND",
	// A person's select_winner / reroute the server's validators refused; the remedy is in `data.fix`.
	GroupActionRefusedError: "PRECONDITION_FAILED",
	RerouteError: "PRECONDITION_FAILED",
	// Path resolved outside the workspace. FORBIDDEN, not NOT_FOUND, so clients can tell them apart.
	PathEscapeError: "FORBIDDEN",
};

const mapErrors = t.middleware(async ({ next }) => {
	const result = await next();
	if (result.ok) return result;
	const cause = result.error.cause;
	let code = cause?.name ? ERROR_CODES[cause.name] : undefined;
	if (cause?.name === "ResourceError") {
		const resourceCode = (cause as Error & { code?: string }).code;
		code =
			resourceCode === "NOT_FOUND"
				? "NOT_FOUND"
				: resourceCode === "CONFLICT" ||
						resourceCode === "STALE_FENCE" ||
						resourceCode === "BUSY"
					? "CONFLICT"
					: resourceCode === "INVALID_TRANSITION" ||
							resourceCode === "FORBIDDEN"
						? "PRECONDITION_FAILED"
						: resourceCode === "REFUSED"
							? "BAD_REQUEST"
							: undefined;
	}
	if (!code) return result;
	return {
		ok: false as const,
		error: new TRPCError({
			code,
			message: cause?.message ?? result.error.message,
			cause,
		}),
		marker: result.marker,
	};
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

const BRAIN_PATHS: ReadonlySet<string> = new Set(["brain.read", "brain.act"]);

/**
 * The second lock behind the HTTP guard: a call with no principal fails here
 * even if a route forgot its guard. Every procedure derives from this one, so
 * despite the historical name nothing on the router is anonymous.
 */
const requirePrincipal = t.middleware(({ ctx, path, next }) => {
	if (!ctx.principal)
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "sign in to use the mfw API",
		});
	if (ctx.principal.kind === "brain" && !BRAIN_PATHS.has(path))
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `'${path}' is not available to a brain turn`,
		});
	return next({ ctx: { ...ctx, principal: ctx.principal } });
});

export const publicProcedure = t.procedure.use(requirePrincipal).use(mapErrors);

/** Input shared by every project-scoped procedure. */
export const projectInput = z.object({ project: z.string().min(1) });

/** Resolves the project's service bag once (`const { tasks } = ctx.svc`). */
export const projectProcedure = publicProcedure
	.input(projectInput)
	.use(({ ctx, input, next }) => {
		if (
			ctx.principal.kind === "brain" &&
			ctx.principal.project !== input.project
		)
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "the token was not issued for that project and turn",
			});
		let svc: ProjectServices;
		try {
			svc = ctx.orchestrator.get(input.project);
		} catch (e) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `unknown project '${input.project}'`,
				cause: e as Error,
			});
		}
		return next({ ctx: { ...ctx, svc } });
	});

/**
 * A brain token is good for one project and turn. This runs on the PARSED
 * input, after the transformer, so nothing in the raw body can differ from
 * what the procedure then receives. Owner calls are unaffected.
 */
export const brainTurnBound = t.middleware(({ ctx, input, next }) => {
	const p = ctx.principal;
	if (p?.kind === "brain") {
		const i = input as { project?: unknown; turnRunId?: unknown };
		if (i.project !== p.project || i.turnRunId !== p.runId)
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "the token was not issued for that project and turn",
			});
	}
	return next();
});
