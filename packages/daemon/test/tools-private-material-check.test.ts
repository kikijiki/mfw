import { expect, test } from "bun:test";
import { scan } from "../../../tools/private-material-check.ts";

test("flags the private repository, project and home paths", () => {
	expect(scan("a.ts", "see backstage architecture.md")).toHaveLength(1);
	expect(scan("a.ts", "code: ../../poot")).toHaveLength(1);
	expect(scan("a.ts", "/home/alice/dev/app")).toHaveLength(1);
	expect(scan("a.ts", "/Users/alice/dev")).toHaveLength(1);
});

test("passes placeholder homes and ordinary text", () => {
	expect(scan("a.ts", "/home/me/dev/app and /home/user/x")).toEqual([]);
	expect(scan("a.ts", "POOT-1 is a fixture id")).toEqual([]);
});
