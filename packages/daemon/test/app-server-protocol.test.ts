import { describe, expect, test } from "bun:test";
import {
	parseAppServerEnvelope,
	rpcError,
	sanitize,
	textInput,
} from "../src/agents/app-server-protocol.ts";

describe("canonical app-server protocol", () => {
	test("accepts requests, responses, and notifications", () => {
		expect(
			parseAppServerEnvelope(
				'{"v":1,"id":1,"method":"initialize","params":{}}',
			),
		).toMatchObject({ id: 1, method: "initialize" });
		expect(parseAppServerEnvelope('{"v":1,"id":1,"result":{}}')).toMatchObject({
			id: 1,
			result: {},
		});
		expect(
			parseAppServerEnvelope(
				'{"v":1,"method":"event","params":{"type":"message"}}',
			),
		).toMatchObject({ method: "event" });
		expect(parseAppServerEnvelope('{"v":2,"id":1,"result":{}}')).toBeNull();
		expect(parseAppServerEnvelope("not json")).toBeNull();
	});

	test("validates canonical text inputs and bounds errors", () => {
		expect(textInput([{ type: "text", text: "hello" }])).toEqual([
			{ type: "text", text: "hello" },
		]);
		expect(textInput([{ type: "image", url: "x" }])).toBeNull();
		expect(
			(
				rpcError(1, "PROVIDER_ERROR", "x".repeat(3000)) as {
					error: { message: string };
				}
			).error.message.length,
		).toBeLessThan(2200);
	});

	test("redacts secrets and bounds provider structures", () => {
		const cleaned = sanitize({
			authorization: "Bearer secret",
			nested: { password: "secret", safe: "ok" },
			many: Array.from({ length: 150 }, (_, i) => i),
		}) as Record<string, unknown>;
		expect(cleaned.authorization).toBe("[REDACTED]");
		expect(cleaned.nested).toEqual({ password: "[REDACTED]", safe: "ok" });
		expect(cleaned.many as unknown[]).toHaveLength(100);
	});
});
