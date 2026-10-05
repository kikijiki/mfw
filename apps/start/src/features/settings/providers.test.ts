import { describe, expect, test } from "bun:test";

import { visibleAuth } from "./ProvidersPanel";

type Auth = Parameters<typeof visibleAuth>[0]["auth"][number];

const provider = (auth: Auth[]) =>
	({ id: "claude-cli", auth }) as Parameters<typeof visibleAuth>[0];

const sub = (configured: boolean) =>
	({ kind: "subscription", configured, via: "", hint: "" }) as Auth;
const key = (configured: boolean) =>
	({
		kind: "api-key",
		configured,
		credentialId: "anthropic",
		via: "",
		hint: "",
	}) as Auth;

/**
 * Which auth methods a provider shows. The rule is one line; the exception is
 * the whole point, so both directions are covered.
 */
describe("visibleAuth", () => {
	test("hides the api-key field when a subscription already authenticates", () => {
		// Claude Code signs in through its own OAuth file. Offering a key there
		// asks for a long-lived secret that buys nothing and that nothing reads.
		const shown = visibleAuth(provider([sub(true), key(false)]), new Set());
		expect(shown.map((a) => a.kind)).toEqual(["subscription"]);
	});

	test("keeps it when no subscription is configured", () => {
		const shown = visibleAuth(provider([sub(false), key(false)]), new Set());
		expect(shown.map((a) => a.kind)).toEqual(["subscription", "api-key"]);
	});

	test("keeps it when a key IS stored, or the key becomes unremovable", () => {
		// `extraCredentials` cannot rescue this one: that list is the credentials
		// no catalogue entry claims, and claude-cli claims `anthropic`.
		const shown = visibleAuth(
			provider([sub(true), key(false)]),
			new Set(["anthropic"]),
		);
		expect(shown.map((a) => a.kind)).toEqual(["subscription", "api-key"]);
	});

	test("a provider with only an api-key method always shows it", () => {
		const shown = visibleAuth(provider([key(false)]), new Set());
		expect(shown.map((a) => a.kind)).toEqual(["api-key"]);
	});
});
