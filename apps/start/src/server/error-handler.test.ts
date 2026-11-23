import { describe, expect, test } from "bun:test";
import { badRequestForUnparseableUrl } from "./error-handler";

describe("malformed requests (reviewer m3)", () => {
	const urlError = () => {
		try {
			new URL("http://localhost:99999/x");
		} catch (e) {
			return e;
		}
		throw new Error("expected a parse failure");
	};

	test("an unparseable URL is a 400 that echoes nothing", async () => {
		const res = badRequestForUnparseableUrl(urlError());
		expect(res?.status).toBe(400);
		expect(await res?.text()).not.toContain("99999");
	});

	test("also when wrapped by the framework", () => {
		const wrapped = new Error("Server Error", { cause: urlError() });
		expect(badRequestForUnparseableUrl(wrapped)?.status).toBe(400);
	});

	test("any other error is left to the default handler", () => {
		expect(badRequestForUnparseableUrl(new Error("boom"))).toBeUndefined();
		expect(badRequestForUnparseableUrl(null)).toBeUndefined();
	});
});
