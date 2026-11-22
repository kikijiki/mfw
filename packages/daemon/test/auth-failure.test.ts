import { describe, expect, test } from "bun:test";
import { AUTH_HOLD_MS, isAuthFailure } from "../src/auth-failure.ts";

describe("isAuthFailure", () => {
	test.each([
		"Not logged in",
		"Please run `codex login` to continue",
		"Your access token could not be refreshed because your refresh token was revoked",
		"Your refresh token has expired. Please log out and sign in again.",
		"OAuth token has expired. Please run /login",
		"Error: authentication failed",
	])("%s", (line) => {
		expect(isAuthFailure(`...\n${line}\n`)).toBe(true);
	});

	test("an access token expiry sentence is matched", () => {
		expect(isAuthFailure("access token is expired")).toBe(true);
	});

	test.each([
		"",
		"fetch returned 401 Unauthorized from the user's API",
		"rate limit reached, try later",
		"added an authentication module",
	])("does not match %p", (line) => {
		expect(isAuthFailure(line)).toBe(false);
	});

	test("only the tail is scanned", () => {
		const long = `not logged in\n${"x".repeat(20_000)}`;
		expect(isAuthFailure(long)).toBe(false);
		expect(isAuthFailure(null)).toBe(false);
	});

	test("the hold outlasts a day", () => {
		expect(AUTH_HOLD_MS).toBe(86_400_000);
	});
});
