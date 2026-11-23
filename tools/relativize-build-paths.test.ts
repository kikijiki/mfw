import { expect, test } from "bun:test";
import { relativize } from "./relativize-build-paths.ts";

test("the build root is removed from route file paths", () => {
	const src = `{ filePath: "/build/apps/start/src/routes/x.tsx" }`;
	expect(relativize(src, "/build/apps/start")).toBe(
		`{ filePath: "src/routes/x.tsx" }`,
	);
	expect(relativize("/other/place", "/build/apps/start")).toBe("/other/place");
});
