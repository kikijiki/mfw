import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collect, render } from "./third-party-notices.ts";

const app = join(import.meta.dir, "..", "apps", "start");

describe("third-party notices", () => {
	const deps = collect(app);
	const text = render(deps);

	test("every vendored font package is listed with the OFL text", () => {
		for (const font of [
			"@fontsource-variable/archivo",
			"@fontsource-variable/figtree",
			"@fontsource-variable/jetbrains-mono",
			"@fontsource-variable/source-sans-3",
			"@fontsource/ibm-plex-mono",
			"@fontsource/ibm-plex-sans-condensed",
		]) {
			const d = deps.find((x) => x.name === font);
			expect(d, font).toBeDefined();
			expect(d?.text).toContain("SIL OPEN FONT LICENSE");
			expect(text).toContain(font);
		}
	});

	test("workspace packages are not listed as third party", () => {
		expect(deps.some((d) => d.name.startsWith("@mfw/"))).toBe(false);
	});

	test("every listed package carries its licence text or says it has none", () => {
		expect(deps.length).toBeGreaterThan(50);
		expect(text).not.toContain("undefined");
	});
});
