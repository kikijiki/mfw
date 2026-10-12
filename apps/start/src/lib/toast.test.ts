import { describe, expect, test } from "bun:test";
import { humanizeError } from "./toast.tsx";

describe("humanizeError", () => {
	test("appends the daemon's fix to a refusal", () => {
		const error = Object.assign(new Error("MFW-1 has 2 commit(s) on mfw/r"), {
			data: {
				code: "PRECONDITION_FAILED",
				fix: { kind: "ui", text: "Merge it, or close with discard." },
			},
		});
		expect(humanizeError(error)).toBe(
			"MFW-1 has 2 commit(s) on mfw/r (PRECONDITION_FAILED). Fix: Merge it, or close with discard.",
		);
	});

	test("leaves an error without a fix as it was", () => {
		const error = Object.assign(new Error("boom"), {
			data: { code: "INTERNAL_SERVER_ERROR", fix: null },
		});
		expect(humanizeError(error)).toBe("boom (INTERNAL_SERVER_ERROR)");
	});
});
