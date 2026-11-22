import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Crafted git bundles for the host-memory tests (security review B1, M1).
 * Nothing here needs a git binary: the objects are written by hand.
 */

const sha1 = (...parts: (Buffer | string)[]): Buffer => {
	const h = createHash("sha1");
	for (const p of parts) h.update(p);
	return h.digest();
};

const objSha = (type: string, body: Buffer): Buffer =>
	sha1(`${type} ${body.length}\0`, body);

function packHeader(type: number, size: number): Buffer {
	const out: number[] = [];
	let b = (type << 4) | (size & 0x0f);
	let rest = Math.floor(size / 16);
	while (rest > 0) {
		out.push(b | 0x80);
		b = rest & 0x7f;
		rest = Math.floor(rest / 128);
	}
	out.push(b);
	return Buffer.from(out);
}

function varint(n: number): Buffer {
	const out: number[] = [];
	let rest = n;
	for (;;) {
		const b = rest % 128;
		rest = Math.floor(rest / 128);
		if (rest > 0) out.push(b | 0x80);
		else {
			out.push(b);
			break;
		}
	}
	return Buffer.from(out);
}

const be32 = (n: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
};

interface PackObj {
	type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 7 ref-delta
	data: Buffer; // uncompressed payload (for a ref-delta: the delta)
	baseSha?: Buffer;
}

function buildPack(objs: PackObj[]): Buffer {
	const parts: Buffer[] = [Buffer.from("PACK"), be32(2), be32(objs.length)];
	for (const o of objs) {
		parts.push(packHeader(o.type, o.data.length));
		if (o.baseSha) parts.push(o.baseSha);
		parts.push(deflateSync(o.data, { level: 9 }));
	}
	const body = Buffer.concat(parts);
	return Buffer.concat([body, sha1(body)]);
}

function commitFor(treeSha: string, msg: string): Buffer {
	const who = "fixture <fixture@example.invalid> 1700000000 +0000";
	return Buffer.from(
		`tree ${treeSha}\nauthor ${who}\ncommitter ${who}\n\n${msg}\n`,
	);
}

function bundleOf(ref: string, tip: Buffer, pack: Buffer): Buffer {
	return Buffer.concat([
		Buffer.from(`# v2 git bundle\n${tip.toString("hex")} ${ref}\n\n`),
		pack,
	]);
}

const BASE = 0xffffff; // largest single copy

/**
 * A tiny bundle whose only blob inflates to `copies * 16 MiB` through one
 * delta of copy instructions. `ref` points at a commit whose tree holds it.
 */
export function deltaBombBundle(ref: string, copies: number): Buffer {
	const base = Buffer.alloc(BASE);
	const baseSha = objSha("blob", base);
	const resultLen = copies * BASE;
	const op = Buffer.from([0xf0, 0xff, 0xff, 0xff]); // copy 0xffffff from offset 0
	const delta = Buffer.concat([
		varint(BASE),
		varint(resultLen),
		...Array.from({ length: copies }, () => op),
	]);
	// sha of the inflated blob, streamed so the test never holds it
	const h = createHash("sha1").update(`blob ${resultLen}\0`);
	for (let i = 0; i < copies; i++) h.update(base);
	const bigSha = h.digest();
	const tree = Buffer.concat([Buffer.from("100644 big\0"), bigSha]);
	const treeSha = objSha("tree", tree);
	const commit = commitFor(treeSha.toString("hex"), "bomb");
	const commitSha = objSha("commit", commit);
	const pack = buildPack([
		{ type: 3, data: base },
		{ type: 7, data: delta, baseSha },
		{ type: 2, data: tree },
		{ type: 1, data: commit },
	]);
	return bundleOf(ref, commitSha, pack);
}

/** A bundle whose `ref` points straight at a blob, a tree or a tag (security review M1). */
export function nonCommitTipBundle(
	ref: string,
	kind: "blob" | "tree" | "tag",
): Buffer {
	const blob = Buffer.from("hello\n");
	const blobSha = objSha("blob", blob);
	const tree = Buffer.concat([Buffer.from("100644 f\0"), blobSha]);
	const treeSha = objSha("tree", tree);
	const commit = commitFor(treeSha.toString("hex"), "c");
	const commitSha = objSha("commit", commit);
	const tag = Buffer.from(
		`object ${commitSha.toString("hex")}\ntype commit\ntag t\ntagger fixture <f@example.invalid> 1700000000 +0000\n\nt\n`,
	);
	const tagSha = objSha("tag", tag);
	const pack = buildPack([
		{ type: 3, data: blob },
		{ type: 2, data: tree },
		{ type: 1, data: commit },
		{ type: 4, data: tag },
	]);
	const tip = kind === "blob" ? blobSha : kind === "tree" ? treeSha : tagSha;
	return bundleOf(ref, tip, pack);
}
