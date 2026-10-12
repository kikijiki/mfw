import { describe, expect, test } from "bun:test";

import { describeKey } from "./keyboard";
import { isMacPlatform, modLabel } from "./platform";

describe("isMacPlatform", () => {
	test("reads userAgentData first, then platform, then the user agent", () => {
		expect(isMacPlatform({ userAgentData: { platform: "macOS" } })).toBe(true);
		expect(
			isMacPlatform({
				userAgentData: { platform: "Linux" },
				platform: "MacIntel",
			}),
		).toBe(false);
		expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
		expect(isMacPlatform({ platform: "iPhone" })).toBe(true);
		expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
		expect(
			isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" }),
		).toBe(true);
		expect(
			isMacPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }),
		).toBe(false);
	});

	test("no navigator (server) is not a Mac", () => {
		expect(isMacPlatform(undefined)).toBe(false);
		expect(isMacPlatform({})).toBe(false);
	});
});

describe("describeKey by platform", () => {
	test("non-Mac says words, Mac says symbols", () => {
		expect(describeKey("mod+k", false)).toBe("Ctrl+K");
		expect(describeKey("mod+k", false, true)).toBe("Ctrl K");
		expect(describeKey("mod+shift+k", false)).toBe("Ctrl+Shift+K");
		expect(describeKey("mod+k", true)).toBe(`${modLabel(true)}K`);
		expect(describeKey("mod+alt+x", true)).toBe("⌘⌥X");
		expect(describeKey("g h", false)).toBe("G then H");
	});
});
