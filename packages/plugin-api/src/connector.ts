import { z } from "zod";
import {
	type CallContext,
	type ContractSpec,
	EpochMs,
	Id,
	JsonObjectSchema,
	LIMITS,
	method,
	Text,
} from "./common.ts";

/**
 * `mfw.connector/v1`: the board on disk is canonical (ADR-1); a connector
 * mirrors. The core owns the mirror journal (ids, last-pushed hash, cursor),
 * the outbound queue and every board write through `board-core`. Inbound
 * changes are proposals, tagged untrusted. On conflict the board wins.
 *
 * Connectors run in `mfw-server` only; `mfw-board` loads no plugins.
 */

/** A read-only view of a board document, as handed to `map`. */
export const BoardDocViewSchema = z.object({
	id: Id,
	type: Id,
	title: Text,
	status: Id.optional(),
	fields: JsonObjectSchema,
	body: z.string().max(LIMITS.text * 50),
	updatedAt: EpochMs,
});
export type BoardDocView = z.infer<typeof BoardDocViewSchema>;

export const ExternalUpsertSchema = z.object({
	docId: Id,
	/** Hash of the mapped payload; the journal uses it to suppress echo. */
	hash: z.string().min(8).max(128),
	externalId: Id.optional(),
	payload: JsonObjectSchema,
});
export type ExternalUpsert = z.infer<typeof ExternalUpsertSchema>;

export const PushResultSchema = z.object({
	results: z
		.array(
			z.discriminatedUnion("status", [
				z.object({ status: z.literal("ok"), docId: Id, externalId: Id }),
				z.object({
					status: z.literal("conflict"),
					docId: Id,
					detail: Text.optional(),
				}),
				z.object({
					status: z.literal("failed"),
					docId: Id,
					retryable: z.boolean(),
					detail: Text.optional(),
				}),
			]),
		)
		.max(LIMITS.list),
});
export type PushResult = z.infer<typeof PushResultSchema>;

/** Always untrusted: it feeds the taint rule and becomes a proposal. */
export const ExternalChangeSchema = z.object({
	externalId: Id,
	kind: z.enum(["upsert", "delete"]),
	fields: JsonObjectSchema.default({}),
	observedAt: EpochMs,
});
export type ExternalChange = z.infer<typeof ExternalChangeSchema>;

const Cursor = z
	.string()
	.max(LIMITS.id * 4)
	.nullable();

export const connectorContract = {
	kind: "connector",
	methods: {
		identity: method(z.object({}), z.object({ system: Id, project: Id })),
		map: method(
			z.object({ doc: BoardDocViewSchema }),
			ExternalUpsertSchema.nullable(),
		),
		push: method(
			z.object({ ops: z.array(ExternalUpsertSchema).max(100) }),
			PushResultSchema,
			{ mutating: true },
		),
		pull: method(
			z.object({ cursor: Cursor }),
			z.object({
				changes: z.array(ExternalChangeSchema).max(LIMITS.list),
				cursor: Cursor,
			}),
		),
	},
} satisfies ContractSpec;

export interface ConnectorPlugin {
	identity(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<{ system: string; project: string }>;
	/** Pure: no I/O, same document gives the same upsert. */
	map(
		params: { doc: BoardDocView },
		ctx: CallContext,
	): Promise<ExternalUpsert | null>;
	push(
		params: { ops: ExternalUpsert[] },
		ctx: CallContext,
	): Promise<PushResult>;
	pull(
		params: { cursor: string | null },
		ctx: CallContext,
	): Promise<{ changes: ExternalChange[]; cursor: string | null }>;
}
