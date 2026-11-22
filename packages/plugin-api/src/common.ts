import { z } from "zod";

/**
 * Shared vocabulary of every plugin contract (`mfw.<kind>/v<n>`).
 *
 * The rule that carries the design: plugins describe and observe, the core
 * decides and enforces. Nothing in this package grants, renews, releases or
 * clears anything; every value a plugin returns is untrusted input that the
 * host validates with the schemas here before using it.
 */

export const CONTRACT_VERSIONS = {
	resource: 1,
	harness: 1,
	provider: 1,
	machine: 1,
	connector: 1,
	notify: 1,
	action: 1,
	facts: 1,
} as const;

export type PluginKind = keyof typeof CONTRACT_VERSIONS;
export const PLUGIN_KINDS = Object.keys(CONTRACT_VERSIONS) as PluginKind[];

export function contractId(kind: PluginKind): string {
	return `mfw.${kind}/v${CONTRACT_VERSIONS[kind]}`;
}

/** Hard limits every host enforces on plugin-supplied data. */
export const LIMITS = {
	/** Longest free text field (names, reasons, detail). */
	text: 2_000,
	/** Longest identifier. */
	id: 128,
	/** Longest list a plugin may return from one call. */
	list: 1_000,
	/** Longest URL. */
	url: 2_048,
} as const;

export const Text = z.string().max(LIMITS.text);
export const Id = z
	.string()
	.min(1)
	.max(LIMITS.id)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);

/** Host-supplied key making a mutating call idempotent. */
export const OperationIdSchema = z
	.string()
	.min(1)
	.max(LIMITS.id)
	.regex(/^[A-Za-z0-9._:-]+$/);
export type OperationId = z.infer<typeof OperationIdSchema>;

/** Epoch milliseconds. */
export const EpochMs = z.number().int().nonnegative();

/** Provenance of a fact: only the host can mint `host-observed`. */
export type Provenance = "host-observed" | "plugin-reported";

/**
 * A measured quantity where `null` is unknown. Unknown never becomes 0: a
 * parser mismatch or a missing report is `null`, and the core charges the
 * reservation as an estimate instead.
 */
export const Measured = z.number().finite().nonnegative().nullable();
export type Measured = z.infer<typeof Measured>;

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string().max(LIMITS.text * 8),
		z.array(JsonSchema).max(LIMITS.list),
		z.record(z.string().max(LIMITS.id), JsonSchema),
	]),
);
export const JsonObjectSchema = z.record(z.string().max(LIMITS.id), JsonSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The five host services a plugin receives, and nothing else. */
export interface HostServices {
	log(level: LogLevel, message: string, fields?: JsonObject): void;
	/** Private, size-capped key-value store. */
	state: {
		get(key: string): Promise<Json | undefined>;
		set(key: string, value: Json): Promise<void>;
		delete(key: string): Promise<void>;
	};
	/** The credential broker: the host injects the secret and makes the call. */
	http(request: BrokerRequest): Promise<BrokerResponse>;
	/** Typed events; the host drops any type the plugin did not declare. */
	emit(type: string, data: JsonObject): void;
	clock: { now(): number };
}

export const BrokerRequestSchema = z.object({
	/** Id of a credential grant the owner approved. */
	grant: Id,
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
	url: z.string().max(LIMITS.url),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.string().optional(),
});
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>;

export interface BrokerResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

/** Passed with every call. A plugin has no other ambient authority. */
export interface CallContext {
	/** Present on every call; mutating methods must be idempotent under it. */
	operationId: OperationId;
	/** Epoch ms after which the host stops waiting. */
	deadline: number;
	/** Aborted on `$/cancel` or deadline. */
	signal: AbortSignal;
	host: HostServices;
}

/** A recoverable refusal, distinct from a crash or a schema violation. */
export const RefusalSchema = z.object({
	ok: z.literal(false),
	reason: Text,
	/** What the owner can do about it. */
	fix: Text.optional(),
});
export type Refusal = z.infer<typeof RefusalSchema>;

export const OkSchema = z.object({ ok: z.literal(true) });

/**
 * One contract method: its parameter and result schemas, and whether it
 * mutates (and so needs an idempotent `operationId`).
 */
export interface MethodSpec<
	P extends z.ZodType = z.ZodType,
	R extends z.ZodType = z.ZodType,
> {
	params: P;
	result: R;
	mutating: boolean;
	optional: boolean;
}

export interface ContractSpec {
	kind: PluginKind;
	methods: Record<string, MethodSpec>;
}

export function method<P extends z.ZodType, R extends z.ZodType>(
	params: P,
	result: R,
	options: { mutating?: boolean; optional?: boolean } = {},
): MethodSpec<P, R> {
	return {
		params,
		result,
		mutating: options.mutating ?? false,
		optional: options.optional ?? false,
	};
}

export class ContractViolation extends Error {
	constructor(
		readonly kind: PluginKind,
		readonly method: string,
		readonly direction: "params" | "result",
		detail: string,
	) {
		super(`mfw.${kind}.${method} ${direction}: ${detail}`);
		this.name = "ContractViolation";
	}
}

type Impl = Record<string, unknown>;

/**
 * Wraps a plugin implementation so every call validates its parameters on the
 * way in and its result on the way out. Hosts use it on the host side of the
 * boundary (a result is untrusted); plugin authors use it to reject malformed
 * input. A schema failure throws `ContractViolation`.
 */
export function bindContract<T extends object>(spec: ContractSpec, impl: T): T {
	const target = impl as Impl;
	const bound: Impl = {};
	for (const [name, m] of Object.entries(spec.methods)) {
		const fn = target[name];
		if (typeof fn !== "function") continue;
		bound[name] = async (params: unknown, ctx: CallContext) => {
			const input = m.params.safeParse(params);
			if (!input.success)
				throw new ContractViolation(
					spec.kind,
					name,
					"params",
					input.error.message,
				);
			const raw = await (fn as (p: unknown, c: CallContext) => unknown).call(
				impl,
				input.data,
				ctx,
			);
			const out = m.result.safeParse(raw);
			if (!out.success)
				throw new ContractViolation(
					spec.kind,
					name,
					"result",
					out.error.message,
				);
			return out.data;
		};
	}
	return bound as T;
}
