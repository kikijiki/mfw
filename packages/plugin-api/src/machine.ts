import { z } from "zod";
import {
	type CallContext,
	type ContractSpec,
	EpochMs,
	Id,
	LIMITS,
	Measured,
	method,
	Text,
} from "./common.ts";
import { PoolIdSchema } from "./pool-id.ts";
import {
	type ResourcePlugin,
	resourceContract,
	type Shape,
	ShapeSchema,
} from "./resource.ts";
import { type MachineEndpoint, MachineEndpointSchema } from "./target.ts";

/**
 * `mfw.machine/v1`: a resource plugin that can also create and destroy
 * machines. A machine plugin is in the data path (it chooses where the repo
 * goes), so enabling one is ask-first and per project.
 *
 * The core owns cleanup records (written BEFORE `provision`), shape
 * enforcement, the ephemeral SSH keypair, readiness proof, teardown proven by
 * a later `inventory`, and the bundle transport.
 */

/** The token the core stamps on everything it creates, to find it again. */
export const OwnershipTokenSchema = z
	.string()
	.min(16)
	.max(LIMITS.id)
	.regex(/^[A-Za-z0-9._:-]+$/);

export const ExternalObjectSchema = z.object({
	externalId: Id,
	/** Null when the object carries no token (never ours to delete). */
	ownershipToken: OwnershipTokenSchema.nullable(),
	state: z.enum([
		"creating",
		"running",
		"stopping",
		"stopped",
		"deleting",
		"error",
	]),
	createdAt: EpochMs,
	/** Billing rate while it exists; null if the provider does not say. */
	usdPerHour: Measured,
});
export type ExternalObject = z.infer<typeof ExternalObjectSchema>;

/**
 * `ambiguous` means the create call may or may not have taken effect (timeout,
 * dropped connection). The core then inventories by token and binds whatever
 * it finds; it never assumes absence.
 */
export const ProvisionResultSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("created"), externalId: Id }),
	z.object({ status: z.literal("ambiguous"), detail: Text.optional() }),
	z.object({ status: z.literal("refused"), reason: Text }),
	z.object({ status: z.literal("failed"), reason: Text }),
]);
export type ProvisionResult = z.infer<typeof ProvisionResultSchema>;

/** `gone` is a claim; only a later `inventory` proves absence. */
export const TeardownResultSchema = z.object({
	status: z.enum(["gone", "deleting", "not-found", "failed"]),
	detail: Text.optional(),
});
export type TeardownResult = z.infer<typeof TeardownResultSchema>;

export const machineContract = {
	kind: "machine",
	methods: {
		...resourceContract.methods,
		provision: method(
			z.object({
				leaseId: Id,
				poolId: PoolIdSchema,
				shape: ShapeSchema,
				ownershipToken: OwnershipTokenSchema,
				/** The core's ephemeral public key; the plugin installs it. */
				sshPublicKey: z.string().min(1).max(2_048),
			}),
			ProvisionResultSchema,
			{ mutating: true },
		),
		inventory: method(
			z.object({ poolId: PoolIdSchema }),
			z.array(ExternalObjectSchema).max(LIMITS.list),
		),
		teardown: method(
			z.object({ externalId: Id, ownershipToken: OwnershipTokenSchema }),
			TeardownResultSchema,
			{ mutating: true },
		),
		endpoint: method(z.object({ externalId: Id }), MachineEndpointSchema),
	},
} satisfies ContractSpec;

export interface MachinePlugin extends ResourcePlugin {
	provision(
		params: {
			leaseId: string;
			poolId: string;
			shape: Shape;
			ownershipToken: string;
			sshPublicKey: string;
		},
		ctx: CallContext,
	): Promise<ProvisionResult>;
	/** Everything in our namespace, including objects the core lost track of. */
	inventory(
		params: { poolId: string },
		ctx: CallContext,
	): Promise<ExternalObject[]>;
	teardown(
		params: { externalId: string; ownershipToken: string },
		ctx: CallContext,
	): Promise<TeardownResult>;
	endpoint(
		params: { externalId: string },
		ctx: CallContext,
	): Promise<MachineEndpoint>;
}
