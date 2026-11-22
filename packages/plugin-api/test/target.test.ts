import { describe, expect, test } from "bun:test";
import {
	type MachineEndpoint,
	mayReceiveWorkloadSecrets,
	validateMachineEndpoint,
} from "../src/target.ts";

const ep = (host: string, port = 22): MachineEndpoint => ({
	host,
	port,
	hostKeySource: "provider-attested",
});
const ok = (host: string, listed: string[] = []) =>
	validateMachineEndpoint(ep(host), listed).ok;

describe("machine endpoint validation", () => {
	test.each([
		"203.0.113.9",
		"8.8.8.8",
		"machine.example.com",
		"ssh.runpod.io",
		"2001:db8::1",
		"[2001:db8::1]",
	])("allows public %s", (host) => {
		expect(ok(host)).toBe(true);
	});

	test.each([
		["127.0.0.1", "loopback"],
		["127.1.2.3", "loopback"],
		["0.0.0.0", "this-network"],
		["10.1.2.3", "private"],
		["172.16.0.1", "private"],
		["172.31.255.255", "private"],
		["192.168.1.1", "private"],
		["169.254.169.254", "metadata"],
		["100.64.0.1", "shared"],
		["224.0.0.1", "multicast"],
		["255.255.255.255", "reserved"],
		["::1", "loopback"],
		["::", "unspecified"],
		["fe80::1", "link-local"],
		["fd00::1", "unique-local"],
		["ff02::1", "multicast"],
		["::ffff:127.0.0.1", "mapped loopback"],
		["::ffff:169.254.169.254", "mapped metadata"],
		["[::1]", "bracketed loopback"],
		["localhost", "local name"],
		["foo.localhost", "local name"],
		["printer.local", "mdns"],
		["metadata.google.internal", "internal"],
		["2130706433", "decimal loopback"],
		["0x7f.1", "hex loopback"],
		["127.1", "short loopback"],
		["host.example.com.", "trailing dot"],
		["single", "single label"],
		["a b.example.com", "space"],
	])("refuses %s (%s)", (host) => {
		expect(ok(host)).toBe(false);
	});

	test("172.15 and 172.32 are public", () => {
		expect(ok("172.15.0.1")).toBe(true);
		expect(ok("172.32.0.1")).toBe(true);
	});

	test("an owner-listed host passes without range checks", () => {
		expect(ok("10.0.0.5", ["10.0.0.5"])).toBe(true);
		expect(ok("BUILD.local", ["build.local"])).toBe(true);
		expect(ok("10.0.0.6", ["10.0.0.5"])).toBe(false);
	});

	test("refusals carry a reason and a fix", () => {
		const v = validateMachineEndpoint(ep("127.0.0.1"));
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.reason).toContain("loopback");
			expect(v.fix).toBeTruthy();
		}
	});

	test("rejects malformed endpoints", () => {
		expect(validateMachineEndpoint(ep("example.com", 0)).ok).toBe(false);
		expect(validateMachineEndpoint(ep("example.com", 70000)).ok).toBe(false);
		expect(validateMachineEndpoint(ep("")).ok).toBe(false);
	});

	test("trust-on-first-use machines never receive workload secrets", () => {
		expect(mayReceiveWorkloadSecrets("tofu")).toBe(false);
		expect(mayReceiveWorkloadSecrets("pinned-by-owner")).toBe(true);
		expect(mayReceiveWorkloadSecrets("provider-attested")).toBe(true);
	});
});
