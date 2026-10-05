import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	testArgs,
	testEnvironment,
	validateTestHome,
} from "../../../tools/root-test.ts";

describe("root test runner isolation", () => {
	test("discovers only the canonical packages and apps trees", () => {
		const root = "/repo";
		expect(testArgs(root)).toEqual([
			"test",
			"--path-ignore-patterns",
			"**/worktrees/**",
			join(root, "packages"),
			join(root, "apps"),
		]);
	});

	test("overrides ambient daemon state with invocation-specific isolation", () => {
		const env = testEnvironment("/tmp/mfw-test-one", "mfw-test-socket", {
			MFW_HOME: "/operator/home",
			MFW_TMUX_SOCKET: "mfw",
			KEEP_ME: "yes",
		});
		expect(env).toMatchObject({
			MFW_HOME: "/tmp/mfw-test-one",
			MFW_TMUX_SOCKET: "mfw-test-socket",
			KEEP_ME: "yes",
		});
	});

	test("cleanup validation accepts only an explicit prefixed temp child", () => {
		expect(validateTestHome("/tmp/mfw-test-abc", "/tmp")).toBe(
			"/tmp/mfw-test-abc",
		);
		for (const unsafe of ["/tmp", "/", "/tmp/not-mfw", "/else/mfw-test-abc"]) {
			expect(() => validateTestHome(unsafe, "/tmp")).toThrow(
				"refusing to clean unvalidated test home",
			);
		}
	});
});
