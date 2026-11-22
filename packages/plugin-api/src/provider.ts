import { z } from "zod";
import {
	type CallContext,
	type ContractSpec,
	EpochMs,
	Id,
	LIMITS,
	Measured,
	method,
	OkSchema,
	RefusalSchema,
	Text,
} from "./common.ts";

/**
 * `mfw.provider/v1`: model endpoints a harness can point at (OpenRouter,
 * llama.cpp, vLLM, any OpenAI-compatible service). Subscription CLIs are
 * harnesses, not providers.
 *
 * The core owns routing, the key, the per-run workload grant, egress for
 * `baseUrl` and the provider's spend pool. A plugin-declared `baseUrl` is
 * egress widening, so it is ask-first. Stale pricing marks cost `estimated`.
 */

export const EndpointDeclSchema = z.object({
	id: Id,
	/** https, or http to a literal loopback; no credentials in the URL. */
	baseUrl: z
		.string()
		.max(LIMITS.url)
		.refine(
			isAllowedBaseUrl,
			"baseUrl must be https (http only to loopback) without credentials",
		),
	api: z.enum(["openai-compatible", "anthropic-messages"]),
	/** Id of the credential grant the core uses; the plugin never sees the key. */
	credentialGrant: Id.optional(),
});
export type EndpointDecl = z.infer<typeof EndpointDeclSchema>;

export function isAllowedBaseUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.username || url.password || url.hash) return false;
	if (url.protocol === "https:") return true;
	return (
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "[::1]")
	);
}

export const ModelDeclSchema = z.object({
	id: Id,
	endpointId: Id,
	tier: z.enum(["light", "standard", "strong"]).optional(),
	contextWindow: z.number().int().positive().optional(),
});
export type ModelDecl = z.infer<typeof ModelDeclSchema>;

export const CatalogueSchema = z.object({
	endpoints: z.array(EndpointDeclSchema).max(LIMITS.list),
	models: z.array(ModelDeclSchema).max(LIMITS.list),
});
export type Catalogue = z.infer<typeof CatalogueSchema>;

/** Prices in USD per million tokens; null is unknown, which makes cost `estimated`. */
export const PriceTableSchema = z.object({
	asOf: EpochMs,
	currency: z.literal("usd"),
	models: z.record(
		Id,
		z.object({
			inputPerMTok: Measured,
			outputPerMTok: Measured,
			cachedInputPerMTok: Measured.optional(),
		}),
	),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

export const AccountObservationSchema = z.object({
	observedAt: EpochMs,
	/** Remaining credit in USD; null is unknown. */
	creditsUsd: Measured,
	rateLimited: z.boolean().default(false),
	detail: Text.optional(),
});
export type AccountObservation = z.infer<typeof AccountObservationSchema>;

export const providerContract = {
	kind: "provider",
	methods: {
		catalogue: method(z.object({}), CatalogueSchema),
		pricing: method(z.object({}), PriceTableSchema.nullable()),
		account: method(z.object({}), AccountObservationSchema, { optional: true }),
		validateCredential: method(
			z.object({}),
			z.union([OkSchema, RefusalSchema]),
			{ optional: true },
		),
	},
} satisfies ContractSpec;

export interface ProviderPlugin {
	catalogue(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<Catalogue>;
	pricing(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<PriceTable | null>;
	account?(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<AccountObservation>;
	/** Through the broker: the plugin asks, the host makes the call. */
	validateCredential?(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<{ ok: true } | { ok: false; reason: string; fix?: string }>;
}
