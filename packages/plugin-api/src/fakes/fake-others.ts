import type { CallContext } from "../common.ts";
import type {
	BoardDocView,
	ConnectorPlugin,
	ExternalChange,
	ExternalUpsert,
	PushResult,
} from "../connector.ts";
import type { FactResult, FactsPlugin, FactTool } from "../facts.ts";
import type {
	ActionResult,
	DeliveryResult,
	NarrowedTriggerView,
	NotifySink,
	RenderedNotification,
	TriggerActionPlugin,
} from "../notify.ts";
import type {
	AccountObservation,
	Catalogue,
	PriceTable,
	ProviderPlugin,
} from "../provider.ts";

/** `mfw.provider/v1` fake with a fixed catalogue and optional pricing. */
export class FakeProvider implements ProviderPlugin {
	catalogueValue: Catalogue = {
		endpoints: [
			{
				id: "fake-endpoint",
				baseUrl: "https://models.example.com/v1",
				api: "openai-compatible",
			},
		],
		models: [{ id: "fake-model", endpointId: "fake-endpoint", tier: "light" }],
	};
	pricingValue: PriceTable | null = null;
	creditsUsd: number | null = 10;
	credentialOk = true;

	async catalogue(): Promise<Catalogue> {
		return this.catalogueValue;
	}
	async pricing(): Promise<PriceTable | null> {
		return this.pricingValue;
	}
	async account(
		_p: Record<string, never>,
		ctx: CallContext,
	): Promise<AccountObservation> {
		return {
			observedAt: ctx.host.clock.now(),
			creditsUsd: this.creditsUsd,
			rateLimited: false,
		};
	}
	async validateCredential() {
		return this.credentialOk
			? ({ ok: true } as const)
			: ({ ok: false, reason: "fake credential rejected" } as const);
	}
}

/**
 * `mfw.connector/v1` fake: an in-memory external system. `push` is idempotent
 * under the op hash, and `pull` yields queued changes once per cursor.
 */
export class FakeConnector implements ConnectorPlugin {
	readonly external = new Map<string, ExternalUpsert>();
	readonly inbound: ExternalChange[] = [];
	pushFailures = 0;

	async identity() {
		return { system: "fake-tracker", project: "fake-project" };
	}
	async map(params: { doc: BoardDocView }): Promise<ExternalUpsert | null> {
		const { doc } = params;
		if (doc.type === "private") return null;
		return {
			docId: doc.id,
			hash: `h-${doc.id}-${doc.updatedAt}`,
			payload: { title: doc.title, status: doc.status ?? null },
		};
	}
	async push(params: { ops: ExternalUpsert[] }): Promise<PushResult> {
		return {
			results: params.ops.map((op) => {
				if (this.pushFailures > 0) {
					this.pushFailures--;
					return {
						status: "failed" as const,
						docId: op.docId,
						retryable: true,
					};
				}
				const externalId = op.externalId ?? `ext-${op.docId}`;
				this.external.set(externalId, op);
				return { status: "ok" as const, docId: op.docId, externalId };
			}),
		};
	}
	async pull(params: { cursor: string | null }) {
		const from = params.cursor ? Number(params.cursor) : 0;
		const changes = this.inbound.slice(from);
		return { changes, cursor: String(this.inbound.length) };
	}
}

/** `mfw.notify/v1` fake that records what it was sent. */
export class FakeSink implements NotifySink {
	readonly delivered: RenderedNotification[] = [];
	readonly seen = new Set<string>();
	status: DeliveryResult["status"] = "delivered";

	async send(
		params: { notification: RenderedNotification },
		ctx: CallContext,
	): Promise<DeliveryResult> {
		if (this.status !== "delivered")
			return { status: this.status, retryable: false };
		if (!this.seen.has(ctx.operationId)) {
			this.seen.add(ctx.operationId);
			this.delivered.push(params.notification);
		}
		return { status: "delivered", retryable: false };
	}
}

/** `mfw.action/v1` fake that records narrowed views. */
export class FakeAction implements TriggerActionPlugin {
	readonly runs: NarrowedTriggerView[] = [];
	readonly seen = new Set<string>();

	async run(
		params: { view: NarrowedTriggerView },
		ctx: CallContext,
	): Promise<ActionResult> {
		if (!this.seen.has(ctx.operationId)) {
			this.seen.add(ctx.operationId);
			this.runs.push(params.view);
		}
		return { status: "ok", retryable: false };
	}
}

/** `mfw.facts/v1` fake exposing one read-only tool. */
export class FakeFacts implements FactsPlugin {
	async describe(): Promise<FactTool[]> {
		return [
			{
				name: "fake_status",
				description: "Returns a fixed status line.",
				inputSchema: { type: "object", properties: {} },
			},
		];
	}
	async query(params: { tool: string }): Promise<FactResult> {
		if (params.tool !== "fake_status") throw new Error("unknown tool");
		return { text: "all quiet", truncated: false };
	}
}
