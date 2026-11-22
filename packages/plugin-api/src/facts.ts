import { z } from "zod";
import {
	type CallContext,
	type ContractSpec,
	JsonObjectSchema,
	LIMITS,
	method,
	Text,
} from "./common.ts";

/**
 * `mfw.facts/v1`: read-only brain tools. Results reach the brain as
 * provenance-tagged untrusted blocks and reading them taints the turn. There
 * are no plugin act tools: `ACT_TOOLS` and their validators are the brain's
 * enforced bounds. MCP servers in runs are fleet config, never a plugin.
 */

export const FactToolSchema = z.object({
	name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	description: Text,
	/** JSON Schema for the arguments; the host validates before `query`. */
	inputSchema: JsonObjectSchema,
});
export type FactTool = z.infer<typeof FactToolSchema>;

export const FactResultSchema = z.object({
	/** Always rendered as quoted, untrusted text. */
	text: z.string().max(LIMITS.text * 8),
	truncated: z.boolean().default(false),
});
export type FactResult = z.infer<typeof FactResultSchema>;

export const factsContract = {
	kind: "facts",
	methods: {
		describe: method(z.object({}), z.array(FactToolSchema).max(64)),
		query: method(
			z.object({ tool: FactToolSchema.shape.name, args: JsonObjectSchema }),
			FactResultSchema,
		),
	},
} satisfies ContractSpec;

export interface FactsPlugin {
	describe(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<FactTool[]>;
	query(
		params: { tool: string; args: Record<string, unknown> },
		ctx: CallContext,
	): Promise<FactResult>;
}
