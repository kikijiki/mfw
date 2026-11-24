import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	buildEpoch,
	buildStampFor,
	stampDefine,
} from "../../../tools/build-stamp.ts";

const root = resolve(import.meta.dir, "../../..");

describe("the build stamp", () => {
	test("SOURCE_DATE_EPOCH sets the build time", () => {
		const stamp = buildStampFor(
			root,
			"compiled",
			{},
			{ SOURCE_DATE_EPOCH: "1700000000" },
		);
		expect(stamp.buildTime).toBe("2023-11-14T22:13:20.000Z");
		expect(stamp.kind).toBe("compiled");
		expect(stamp.bunVersion).toBe(Bun.version);
	});

	test("without it, the time is the commit's, so two builds agree", () => {
		const a = buildEpoch(root, {});
		const b = buildEpoch(root, {});
		expect(a).toBe(b);
	});

	test("a malformed SOURCE_DATE_EPOCH is refused", () => {
		expect(() => buildEpoch(root, { SOURCE_DATE_EPOCH: "yesterday" })).toThrow(
			/not a whole number/,
		);
	});

	test("the define is one JSON constant", () => {
		const stamp = buildStampFor(root, "bundle", {}, { SOURCE_DATE_EPOCH: "0" });
		const define = stampDefine(stamp);
		expect(Object.keys(define)).toEqual(["__MFW_BUILD__"]);
		expect(JSON.parse(define.__MFW_BUILD__ as string)).toEqual(stamp);
		expect(stamp.version).toBe(
			JSON.parse(
				require("node:fs").readFileSync(join(root, "package.json"), "utf8"),
			).version,
		);
	});
});
