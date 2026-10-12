import { describe, expect, test } from "bun:test";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

/** A registry double over one in-memory transcript, counting file reads. */
function fakeRegistry(initial: string) {
	let content = Buffer.from(initial);
	const state = { value: "running" };
	const reads: number[] = [];
	const registry = {
		async readOutput(_runId: string, _file: string, offset: number) {
			reads.push(offset);
			const start = Math.min(offset, content.length);
			return {
				chunk: content.subarray(start).toString("utf8"),
				size: content.length,
				complete: true,
			};
		},
		async get() {
			return { state: state.value };
		},
	};
	return {
		registry,
		reads,
		append(text: string) {
			content = Buffer.concat([content, Buffer.from(text)]);
		},
		finish(to = "completed") {
			state.value = to;
		},
	};
}

function caller(registry: unknown) {
	const svc = { name: "p", registry } as unknown as ProjectServices;
	const orchestrator = { get: () => svc } as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

async function open(
	api: ReturnType<typeof caller>,
	offset = 0,
): Promise<AsyncIterator<unknown>> {
	const stream = await api.live.runOutput({
		project: "p",
		runId: "r1",
		offset,
	});
	return stream[Symbol.asyncIterator]();
}

async function nextOf(it: AsyncIterator<unknown>) {
	return (await it.next()).value as Record<string, unknown>;
}

describe("live.runOutput tail fan-out", () => {
	test("three subscribers to one run cause one file read per tick", async () => {
		const f = fakeRegistry("a\n");
		const api = caller(f.registry);
		const its = await Promise.all([open(api), open(api), open(api)]);

		const first = await Promise.all(its.map(nextOf));
		for (const d of first)
			expect(d).toEqual({ kind: "delta", chunk: "a\n", offset: 2 });
		expect(f.reads).toEqual([0]);

		f.append("b\n");
		const second = await Promise.all(its.map(nextOf));
		for (const d of second)
			expect(d).toEqual({ kind: "delta", chunk: "b\n", offset: 4 });
		// One more read at the shared cursor, not three.
		expect(f.reads).toEqual([0, 2]);

		f.finish();
		const ends = await Promise.all(its.map(nextOf));
		for (const d of ends)
			expect(d).toMatchObject({ kind: "end", state: "completed", offset: 4 });
		for (const it of its) await it.return?.();
	}, 15_000);

	test("a late subscriber is served from the shared window, and one at the head only gets new bytes", async () => {
		const f = fakeRegistry("one\n");
		const api = caller(f.registry);
		const a = await open(api);
		expect(await nextOf(a)).toMatchObject({ chunk: "one\n", offset: 4 });
		const readsBefore = f.reads.length;

		const fromStart = await open(api, 0);
		expect(await nextOf(fromStart)).toEqual({
			kind: "delta",
			chunk: "one\n",
			offset: 4,
		});
		// Served from the window: no extra read for the replay.
		expect(f.reads.length).toBe(readsBefore);

		const atHead = await open(api, 4);
		f.append("two\n");
		expect(await nextOf(atHead)).toEqual({
			kind: "delta",
			chunk: "two\n",
			offset: 8,
		});
		expect(await nextOf(a)).toMatchObject({ chunk: "two\n", offset: 8 });
		expect(await nextOf(fromStart)).toMatchObject({ chunk: "two\n" });
		for (const it of [a, fromStart, atHead]) await it.return?.();
	}, 15_000);

	test("a finished run ends with its terminal state after the drained output", async () => {
		const f = fakeRegistry("x\n");
		f.finish("failed");
		const api = caller(f.registry);
		const it = await open(api);
		expect(await nextOf(it)).toMatchObject({ kind: "delta", chunk: "x\n" });
		expect(await nextOf(it)).toEqual({
			kind: "end",
			state: "failed",
			offset: 2,
		});
	});

	test("the reader stops when the last subscriber leaves", async () => {
		const f = fakeRegistry("x\n");
		const api = caller(f.registry);
		const it = await open(api);
		await nextOf(it);
		await it.return?.();
		const after = f.reads.length;
		await Bun.sleep(700);
		expect(f.reads.length).toBe(after);
	}, 15_000);
});
