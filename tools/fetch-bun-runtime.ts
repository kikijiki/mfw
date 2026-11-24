#!/usr/bin/env bun
/**
 * Gets the pinned official bun (packaging/bun-runtime.json) and checks it.
 *
 *   bun run tools/fetch-bun-runtime.ts --out <path> [--zip <release zip>]
 *                                      [--target bun-linux-x64] [--pin <json>]
 *
 * With `--zip`, nothing is downloaded: the zip you fetched yourself is checked
 * and unpacked. Without it, the release asset is downloaded from the pinned
 * URL first. Either way the zip's sha256 must equal the pin before anything is
 * extracted, and the bun inside is written to `<out>` read-only. It then serves
 * as `--runtime` for tools/install-build.ts (the server's runtime) and as
 * `--bun-executable` for tools/compile.ts (a portable compile base).
 *
 * The zip reader below handles exactly what bun's release zips use (stored and
 * deflated entries, no encryption, no zip64), so no `unzip` is needed.
 */

import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface RuntimePin {
	version: string;
	releaseUrl: string;
	targets: Record<string, { asset: string; member: string; sha256: string }>;
}

export function readPin(path: string): RuntimePin {
	const pin = JSON.parse(readFileSync(path, "utf8")) as RuntimePin;
	if (typeof pin.version !== "string" || typeof pin.releaseUrl !== "string") {
		throw new Error(`${path} is not a runtime pin`);
	}
	for (const [target, t] of Object.entries(pin.targets ?? {})) {
		if (!/^[0-9a-f]{64}$/.test(t.sha256) || !t.asset || !t.member) {
			throw new Error(`${path}: the pin for ${target} is incomplete`);
		}
	}
	return pin;
}

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** One member of a zip, from its central directory. */
export function zipMember(zip: Uint8Array, name: string): Uint8Array {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip file");
	const entries = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder();
	for (let n = 0; n < entries; n++) {
		if (view.getUint32(at, true) !== 0x02014b50)
			throw new Error("bad zip directory");
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const compressed = view.getUint32(at + 20, true);
		const size = view.getUint32(at + 24, true);
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const entryName = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
		at += 46 + nameLen + extraLen + commentLen;
		if (entryName !== name) continue;
		if (flags & 0x1) throw new Error(`${name} is encrypted`);
		if (view.getUint32(local, true) !== 0x04034b50)
			throw new Error("bad zip entry");
		const start =
			local +
			30 +
			view.getUint16(local + 26, true) +
			view.getUint16(local + 28, true);
		const data = zip.subarray(start, start + compressed);
		const out =
			method === 0
				? data
				: method === 8
					? new Uint8Array(inflateRawSync(data))
					: null;
		if (!out) throw new Error(`${name} uses an unsupported compression method`);
		if (out.length !== size) throw new Error(`${name} has the wrong size`);
		return out;
	}
	throw new Error(`the zip has no ${name}`);
}

/** Check `zip` against the pin and write its bun to `out`, read-only. Returns the bun's sha256. */
export function installRuntime(
	zip: Uint8Array,
	pin: RuntimePin,
	target: string,
	out: string,
): string {
	const t = pin.targets[target];
	if (!t) throw new Error(`no pinned bun for ${target}`);
	const actual = sha256(zip);
	if (actual !== t.sha256) {
		throw new Error(
			`refusing: ${t.asset} has sha256 ${actual}, but bun ${pin.version} is pinned at ${t.sha256}`,
		);
	}
	const bun = zipMember(zip, t.member);
	const tmp = join(dirname(out), `.bun-${process.pid}.tmp`);
	writeFileSync(tmp, bun, { mode: 0o555, flag: "wx" });
	chmodSync(tmp, 0o555);
	renameSync(tmp, out);
	return sha256(bun);
}

function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const out = flag(argv, "--out");
	if (!out) {
		console.error(
			"usage: fetch-bun-runtime.ts --out <path> [--zip <release zip>] [--target bun-linux-x64] [--pin <json>]",
		);
		process.exit(2);
	}
	try {
		const pin = readPin(
			resolve(
				flag(argv, "--pin") ??
					join(import.meta.dir, "../packaging/bun-runtime.json"),
			),
		);
		const target = flag(argv, "--target") ?? "bun-linux-x64";
		const t = pin.targets[target];
		if (!t) throw new Error(`no pinned bun for ${target}`);
		let zip: Uint8Array;
		const given = flag(argv, "--zip");
		if (given) {
			zip = readFileSync(resolve(given));
		} else {
			const url = `${pin.releaseUrl}/${t.asset}`;
			console.log(`downloading ${url}`);
			const r = await fetch(url, { redirect: "follow" });
			if (!r.ok) throw new Error(`${url} returned ${r.status}`);
			zip = new Uint8Array(await r.arrayBuffer());
		}
		const sha = installRuntime(zip, pin, target, resolve(out));
		console.log(
			`bun ${pin.version} (${target}) checked and written to ${resolve(out)}, sha256 ${sha}`,
		);
	} catch (e) {
		console.error(`fetch-bun-runtime: ${(e as Error).message}`);
		process.exit(1);
	}
}
