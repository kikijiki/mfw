import { describe, expect, test } from "bun:test";
import { doctorResponseMeta } from "./trpc-handler";

describe("L4: the doctor's response is never cached", () => {
	test("a request for it is no-store", () => {
		expect(
			doctorResponseMeta(["system.doctor"]).headers?.get("cache-control"),
		).toBe("no-store");
	});

	test("so is a batch containing it", () => {
		expect(
			doctorResponseMeta(["system.health", "system.doctor"]).headers?.get(
				"cache-control",
			),
		).toBe("no-store");
	});

	test("other procedures are left alone", () => {
		expect(doctorResponseMeta(["system.health"]).headers).toBeUndefined();
		expect(doctorResponseMeta(undefined).headers).toBeUndefined();
	});
});
