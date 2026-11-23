import { describe, expect, test } from "bun:test";
import { TOKEN_SCOPES } from "@mfw/daemon/auth/tokens";
import { TOKEN_SCOPE_CHOICES, tokenDraft } from "./tokensForm";

const form = { name: "ci", scopes: ["board:read"], project: "", days: "1" };

describe("tokenDraft", () => {
	test("offers exactly the server's scopes", () => {
		expect(TOKEN_SCOPE_CHOICES.map((c) => c.scope)).toEqual([...TOKEN_SCOPES]);
	});

	test("builds a request, with the project only when set", () => {
		expect(tokenDraft(form)).toEqual({
			name: "ci",
			scopes: ["board:read"],
			ttlMs: 86_400_000,
		});
		expect(tokenDraft({ ...form, project: " alpha " })).toMatchObject({
			project: "alpha",
		});
	});

	for (const [label, bad] of [
		["no name", { ...form, name: "  " }],
		["no scopes", { ...form, scopes: [] }],
		["zero days", { ...form, days: "0" }],
		["too many days", { ...form, days: "91" }],
		["fractional days", { ...form, days: "1.5" }],
		["empty days", { ...form, days: "" }],
	] as const)
		test(`refuses ${label}`, () => {
			expect(typeof tokenDraft(bad)).toBe("string");
		});
});
