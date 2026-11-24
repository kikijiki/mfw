import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collect, render } from "../../../tools/third-party-notices.ts";

const app = join(import.meta.dir, "..", "..", "..", "apps", "start");

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

	test("the WebAuthn verifier and every package it pulls in are listed with their licence text", () => {
		// Exactly the packages `deps: add @simplewebauthn/server 14.1.0` added to
		// bun.lock. A change here is a dependency change: review it as one.
		for (const want of [
			"@simplewebauthn/server@14.1.0 (MIT)",
			"@hexagon/base64@1.1.28 (MIT)",
			"@levischuck/tiny-cbor@0.2.11 (MIT)",
			"@peculiar/asn1-android@2.11.1 (MIT)",
			"@peculiar/asn1-asym-key@2.11.1 (MIT)",
			"@peculiar/asn1-cms@2.11.1 (MIT)",
			"@peculiar/asn1-csr@2.11.1 (MIT)",
			"@peculiar/asn1-ecc@2.11.1 (MIT)",
			"@peculiar/asn1-pfx@2.11.1 (MIT)",
			"@peculiar/asn1-pkcs8@2.11.1 (MIT)",
			"@peculiar/asn1-pkcs9@2.11.1 (MIT)",
			"@peculiar/asn1-rsa@2.11.1 (MIT)",
			"@peculiar/asn1-schema@2.11.1 (MIT)",
			"@peculiar/asn1-x509@2.11.1 (MIT)",
			"@peculiar/asn1-x509-attr@2.11.1 (MIT)",
			"@peculiar/asn1-x509-post-quantum@2.11.1 (MIT)",
			"@peculiar/utils@2.0.3 (MIT)",
			"@peculiar/x509@2.2.0 (MIT)",
			"asn1js@3.1.0 (BSD-3-Clause)",
			"pvtsutils@1.3.6 (MIT)",
			"pvutils@1.2.0 (MIT)",
			"reflect-metadata@0.2.2 (Apache-2.0)",
			"tsyringe@4.10.0 (MIT)",
			"tslib@1.14.1 (0BSD)",
		]) {
			const d = deps.find(
				(x) => `${x.name}@${x.version} (${x.license})` === want,
			);
			expect(d, want).toBeDefined();
			expect(d?.text.length, want).toBeGreaterThan(200);
			expect(text).toContain(want);
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
