import { describe, expect, test } from "bun:test";
import type {
	EventStore,
	Orchestrator,
	ProjectServices,
	StoredEvent,
} from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

type Listener = (event: StoredEvent) => void;

class TestBus {
	private listeners = new Set<Listener>();

	subscribe(listener: Listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(events: StoredEvent[]) {
		for (const item of events) {
			for (const listener of this.listeners) listener(item);
		}
	}
}

function event(seq: number): StoredEvent {
	return {
		type: "scheduler.paused",
		payload: { reason: "test" },
		seq,
		ts: seq,
	};
}

function stream(events: EventStore, bus: TestBus, sinceSeq = 0) {
	const svc = { name: "project", events, bus } as unknown as ProjectServices;
	const orchestrator = {
		get: (name: string) => {
			if (name !== svc.name) throw new Error("unknown project");
			return svc;
		},
	} as Orchestrator;
	return createCaller({ orchestrator }).live.events({
		project: svc.name,
		sinceSeq,
	});
}

describe("live event gap recovery", () => {
	test("a backfill gap advances to the true head and retains concurrent rows", async () => {
		const bus = new TestBus();
		const events: EventStore = {
			since: async () => Array.from({ length: 501 }, (_, i) => event(i + 1)),
			latestSeq: async () => {
				queueMicrotask(() =>
					bus.publish([event(650), event(651), event(651), event(652)]),
				);
				return 650;
			},
			list: async () => {
				throw new Error("unused");
			},
		};
		const iterator = (await stream(events, bus))[Symbol.asyncIterator]();

		expect((await iterator.next()).value).toEqual({
			kind: "gap",
			fromSeq: 0,
			lastSeq: 650,
		});
		expect((await iterator.next()).value).toMatchObject({
			kind: "event",
			event: { seq: 651 },
		});
		expect((await iterator.next()).value).toMatchObject({
			kind: "event",
			event: { seq: 652 },
		});
		await iterator.return?.();
	});

	test("queue overflow gaps from the applied cursor to the durable head", async () => {
		const bus = new TestBus();
		const events: EventStore = {
			since: async () => {
				bus.publish(Array.from({ length: 501 }, (_, i) => event(i + 101)));
				return [];
			},
			latestSeq: async () => {
				queueMicrotask(() => bus.publish([event(700), event(701), event(702)]));
				return 700;
			},
			list: async () => {
				throw new Error("unused");
			},
		};
		const iterator = (await stream(events, bus, 100))[Symbol.asyncIterator]();

		expect((await iterator.next()).value).toEqual({
			kind: "gap",
			fromSeq: 100,
			lastSeq: 700,
		});
		expect((await iterator.next()).value).toMatchObject({
			kind: "event",
			event: { seq: 701 },
		});
		expect((await iterator.next()).value).toMatchObject({
			kind: "event",
			event: { seq: 702 },
		});
		await iterator.return?.();
	});
});
