import type {
	BrokerRequest,
	BrokerResponse,
	CallContext,
	HostServices,
	Json,
	JsonObject,
	LogLevel,
	OperationId,
} from "../common.ts";

/** Injectable clock: a plugin never reads the wall clock directly. */
export class FakeClock {
	constructor(private t = 1_700_000_000_000) {}
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

export interface RecordedLog {
	level: LogLevel;
	message: string;
	fields?: JsonObject;
}
export interface RecordedEvent {
	type: string;
	data: JsonObject;
}

/**
 * A fake host for plugin tests and the conformance kit: recorded broker
 * calls, captured logs and events, an injectable clock and a size-capped
 * private state. Broker replies are scripted with `respond`.
 */
export class FakeHost implements HostServices {
	readonly clock = new FakeClock();
	readonly logs: RecordedLog[] = [];
	readonly events: RecordedEvent[] = [];
	readonly httpCalls: BrokerRequest[] = [];
	readonly stateData = new Map<string, Json>();
	/** Scripted broker behaviour; the default is a 200 with an empty body. */
	respond: (req: BrokerRequest) => BrokerResponse | Promise<BrokerResponse> =
		() => ({
			status: 200,
			headers: {},
			body: "",
		});

	constructor(private readonly maxStateBytes = 1_048_576) {}

	log(level: LogLevel, message: string, fields?: JsonObject): void {
		this.logs.push(fields ? { level, message, fields } : { level, message });
	}

	readonly state = {
		get: async (key: string) => this.stateData.get(key),
		set: async (key: string, value: Json) => {
			const next = new Map(this.stateData).set(key, value);
			if (JSON.stringify([...next]).length > this.maxStateBytes)
				throw new Error("plugin state exceeds its size cap");
			this.stateData.set(key, value);
		},
		delete: async (key: string) => {
			this.stateData.delete(key);
		},
	};

	async http(request: BrokerRequest): Promise<BrokerResponse> {
		this.httpCalls.push(request);
		return this.respond(request);
	}

	emit(type: string, data: JsonObject): void {
		this.events.push({ type, data });
	}

	context(
		operationId: OperationId = "op-1",
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): CallContext {
		return {
			operationId,
			deadline: this.clock.now() + (options.timeoutMs ?? 30_000),
			signal: options.signal ?? new AbortController().signal,
			host: this,
		};
	}
}
