import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EgressHarness,
	HARNESS_EGRESS,
	harnessAllowlist,
	harnessEgressEnv,
} from "../src/containment/egress-allowlists.ts";
import {
	buildAllowlist,
	canonicalAddress,
	isNumericHost,
	resolvePinned,
} from "../src/containment/egress-policy.ts";
import {
	createConnectionGate,
	type EgressProxy,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";
import { isAllowedEnvName } from "../src/containment/profile.ts";

const HARNESSES = Object.keys(HARNESS_EGRESS) as EgressHarness[];

describe("harness allowlists", () => {
	test("the exact default lists", () => {
		expect(harnessAllowlist("claude")).toEqual([
			{ host: "api.anthropic.com", port: 443 },
			{ host: "platform.claude.com", port: 443 },
		]);
		expect(harnessAllowlist("codex")).toEqual([
			{ host: "chatgpt.com", port: 443 },
			{ host: "api.openai.com", port: 443 },
			{ host: "auth.openai.com", port: 443 },
		]);
	});

	test.each(HARNESSES)("%s: telemetry hosts need the opt-in", (h) => {
		const telemetry = HARNESS_EGRESS[h].entries
			.filter((e) => e.purpose === "telemetry")
			.map((e) => e.host);
		expect(telemetry.length).toBeGreaterThan(0);
		const off = harnessAllowlist(h).map((e) => e.host);
		const on = harnessAllowlist(h, { telemetry: true }).map((e) => e.host);
		for (const host of telemetry) {
			expect(off).not.toContain(host);
			expect(on).toContain(host);
		}
	});

	test.each(
		HARNESSES,
	)("%s: every entry is exact, sourced and accepted", (h) => {
		for (const e of HARNESS_EGRESS[h].entries) {
			expect(e.host).not.toContain("*");
			expect(isNumericHost(e.host)).toBe(false);
			expect(e.port).toBe(443);
			expect(e.source.length).toBeGreaterThan(0);
		}
		const list = buildAllowlist(harnessAllowlist(h, { telemetry: true }));
		expect(list.entries().length).toBe(HARNESS_EGRESS[h].entries.length);
	});

	test("a subdomain or another port of an allowed host is not allowed", () => {
		const list = buildAllowlist(harnessAllowlist("claude"));
		expect(list.has("api.anthropic.com", 443)).toBe(true);
		expect(list.has("x.api.anthropic.com", 443)).toBe(false);
		expect(list.has("api.anthropic.com", 80)).toBe(false);
		expect(list.has("anthropic.com", 443)).toBe(false);
	});

	test("telemetry is told off unless opted in, with allowlisted names", () => {
		const off = harnessEgressEnv("claude");
		expect(off.DISABLE_TELEMETRY).toBe("1");
		expect(off.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
		for (const name of Object.keys(off)) {
			expect(isAllowedEnvName(name)).toBe(true);
		}
		expect(harnessEgressEnv("claude", { telemetry: true })).toEqual({});
	});
});

describe("the host's own addresses", () => {
	test("two spellings of one address compare equal", () => {
		expect(canonicalAddress("2606:4700::1")).toBe(
			canonicalAddress("2606:4700:0:0:0:0:0:1"),
		);
		expect(canonicalAddress("::ffff:8.8.8.8")).toBe("8.8.8.8");
		expect(canonicalAddress("fe80::1%eth0")).toBe(canonicalAddress("fe80::1"));
		expect(canonicalAddress("not-an-ip")).toBeNull();
	});

	test("a public answer on a local interface denies the whole name", async () => {
		const own = (ip: string) => ip === "8.8.4.4";
		expect(
			await resolvePinned("a.test", async () => ["8.8.8.8", "8.8.4.4"], own),
		).toMatchObject({ ok: false, status: 403, reason: "host-address" });
		expect(await resolvePinned("a.test", async () => ["8.8.8.8"], own)).toEqual(
			{ ok: true, ip: "8.8.8.8" },
		);
	});

	let dir: string | undefined;
	let proxy: EgressProxy | undefined;
	afterEach(async () => {
		await proxy?.close();
		proxy = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	test("the proxy refuses it and never dials", async () => {
		dir = mkdtempSync(join(tmpdir(), "mfw-eg-own-"));
		let dialed = 0;
		proxy = await startEgressProxy({
			runId: "r",
			socketPath: join(dir, "e.sock"),
			allow: ["own.test"],
			gate: createConnectionGate(4),
			resolve: async () => ["2606:4700::1"],
			localAddresses: () => ["2606:4700:0:0:0:0:0:1"],
			connect: () => {
				dialed++;
				throw new Error("must not dial");
			},
		});
		const answer = await new Promise<string>((done, fail) => {
			let out = "";
			const c = net.connect(join(dir as string, "e.sock"), () =>
				c.write("CONNECT own.test:443 HTTP/1.1\r\n\r\n"),
			);
			c.on("data", (d) => {
				out += d.toString();
			});
			c.on("close", () => done(out));
			c.on("error", fail);
		});
		expect(answer).toContain("403");
		expect(answer).toContain("host-address");
		expect(dialed).toBe(0);
	});
});
