/** A minimal TLS ClientHello record naming `sni`, for proxy tests. */
export function clientHello(sni: string | null): Buffer {
	const ext: number[] = [];
	if (sni !== null) {
		const name = Buffer.from(sni, "latin1");
		const list = [0, name.length >> 8, name.length & 0xff, ...name];
		const body = [list.length >> 8, list.length & 0xff, ...list];
		ext.push(0, 0, body.length >> 8, body.length & 0xff, ...body);
	}
	const exts = [ext.length >> 8, ext.length & 0xff, ...ext];
	const body = [
		0x03,
		0x03,
		...new Array(32).fill(7),
		0,
		0,
		2,
		0x13,
		0x01,
		1,
		0,
		...exts,
	];
	const hs = [0x01, 0, body.length >> 8, body.length & 0xff, ...body];
	return Buffer.from([
		0x16,
		0x03,
		0x01,
		hs.length >> 8,
		hs.length & 0xff,
		...hs,
	]);
}
