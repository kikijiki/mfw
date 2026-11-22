import type { CallContext } from "../common.ts";
import type {
	ExternalObject,
	MachinePlugin,
	ProvisionResult,
	TeardownResult,
} from "../machine.ts";
import type { Shape } from "../resource.ts";
import type { MachineEndpoint } from "../target.ts";
import { FakeResource } from "./fake-resource.ts";

/**
 * The cloud a `FakeMachine` talks to. It outlives a plugin instance, so a test
 * can "crash" the plugin after `provision` and build a new one over the same
 * world, which is how the crash-then-inventory suite works.
 */
export class FakeCloud {
	readonly objects = new Map<string, ExternalObject>();
	/** operationId -> externalId, so a repeated create returns the same machine. */
	readonly created = new Map<string, string>();
	private seq = 0;
	nextId(): string {
		return `fake-m-${++this.seq}`;
	}
}

export type ProvisionMode =
	/** Normal: the object exists and `created` is returned. */
	| "ok"
	/** The create took effect but the reply is lost: `ambiguous`. */
	| "ambiguous-created"
	/** The create did not take effect and the reply is lost: `ambiguous`. */
	| "ambiguous-lost"
	| "refuse"
	| "fail";

/** `mfw.machine/v1` fake: ambiguous create, lost object, idempotent under operationId. */
export class FakeMachine extends FakeResource implements MachinePlugin {
	mode: ProvisionMode = "ok";
	/** Teardown reports `gone` but leaves the object (a lying plugin). */
	lieOnTeardown = false;
	endpointOverride: MachineEndpoint | null = null;

	constructor(
		readonly cloud: FakeCloud = new FakeCloud(),
		...rest: ConstructorParameters<typeof FakeResource>
	) {
		super(...rest);
	}

	async provision(
		params: {
			leaseId: string;
			poolId: string;
			shape: Shape;
			ownershipToken: string;
			sshPublicKey: string;
		},
		ctx: CallContext,
	): Promise<ProvisionResult> {
		this.calls.push({ method: "provision", operationId: ctx.operationId });
		const prior = this.cloud.created.get(ctx.operationId);
		if (prior) return { status: "created", externalId: prior };
		if (this.mode === "refuse")
			return { status: "refused", reason: "shape refused by fake machine" };
		if (this.mode === "fail")
			return { status: "failed", reason: "fake failure" };
		if (this.mode === "ambiguous-lost") return { status: "ambiguous" };
		const externalId = this.cloud.nextId();
		this.cloud.objects.set(externalId, {
			externalId,
			ownershipToken: params.ownershipToken,
			state: "running",
			createdAt: ctx.host.clock.now(),
			usdPerHour: this.usdPerUnitHour,
		});
		this.cloud.created.set(ctx.operationId, externalId);
		if (this.mode === "ambiguous-created") return { status: "ambiguous" };
		return { status: "created", externalId };
	}

	async inventory(
		_p: { poolId: string },
		ctx: CallContext,
	): Promise<ExternalObject[]> {
		this.calls.push({ method: "inventory", operationId: ctx.operationId });
		return [...this.cloud.objects.values()];
	}

	async teardown(
		params: { externalId: string; ownershipToken: string },
		ctx: CallContext,
	): Promise<TeardownResult> {
		this.calls.push({ method: "teardown", operationId: ctx.operationId });
		const obj = this.cloud.objects.get(params.externalId);
		if (!obj) return { status: "not-found" };
		if (obj.ownershipToken !== params.ownershipToken)
			return { status: "failed", detail: "ownership token mismatch" };
		if (!this.lieOnTeardown) this.cloud.objects.delete(params.externalId);
		return { status: "gone" };
	}

	async endpoint(
		params: { externalId: string },
		ctx: CallContext,
	): Promise<MachineEndpoint> {
		this.calls.push({ method: "endpoint", operationId: ctx.operationId });
		if (!this.cloud.objects.has(params.externalId))
			throw new Error(`unknown machine ${params.externalId}`);
		return (
			this.endpointOverride ?? {
				host: "machine.example.com",
				port: 22,
				hostKeySource: "tofu",
			}
		);
	}
}
