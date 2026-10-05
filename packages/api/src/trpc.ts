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
	NotFoundError: "NOT_FOUND",
	// Path resolved outside the workspace. FORBIDDEN, not NOT_FOUND, so clients can tell them apart.
	PathEscapeError: "FORBIDDEN",
};

const mapErrors = t.middleware(async ({ next }) => {
	const result = await next();
	if (result.ok) return result;
	const cause = result.error.cause;
	let code = cause?.name ? ERROR_CODES[cause.name] : undefined;
	if (cause?.name === "HostStoreError") {
		const hostCode = (cause as Error & { code?: string }).code;
		code =
			hostCode === "NOT_FOUND"
				? "NOT_FOUND"
				: hostCode === "STALE_VERSION" ||
						hostCode === "STALE_FENCE" ||
						hostCode === "BUSY"
					? "CONFLICT"
					: hostCode === "INVALID_TRANSITION"
						? "PRECONDITION_FAILED"
						: hostCode === "INVALID_REQUEST"
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
export const publicProcedure = t.procedure.use(mapErrors);

/** Input shared by every project-scoped procedure. */
export const projectInput = z.object({ project: z.string().min(1) });

/** Resolves the project's service bag once (`const { tasks } = ctx.svc`). */
export const projectProcedure = publicProcedure
	.input(projectInput)
	.use(({ ctx, input, next }) => {
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
