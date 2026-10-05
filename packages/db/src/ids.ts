/**
 * One ID grammar:
 *   task     ^<KEY>-[1-9][0-9]*$          e.g. MFW-42
 *   spec     ^<KEY>-SPEC-[1-9][0-9]*$     e.g. MFW-118
 *   run      ULID (time-ordered, doubles as run dir name)
 *   file-defined definitions (lifetime, triggers)
 *            ^[a-z][a-z0-9-]{1,40}$
 */

export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** The id grammar for every human-authored definition file under `.mfw/`. */
export const DEF_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** @deprecated the same grammar, named before triggers also used it. */
export const LIFETIME_ID_RE = DEF_ID_RE;

export function taskIdRe(key: string): RegExp {
	return new RegExp(`^${key}-[1-9][0-9]*$`);
}

export function parseTaskNum(key: string, id: string): number | null {
	const m = taskIdRe(key).exec(id);
	return m ? Number(id.slice(key.length + 1)) : null;
}

/** Derive a default project key from a directory name: "my-app2" → "MYAPP2". */
export function deriveKey(dirName: string): string {
	const cleaned = dirName.toUpperCase().replace(/[^A-Z0-9]/g, "");
	let key = /^[A-Z]/.test(cleaned) ? cleaned : `P${cleaned}`;
	if (key.length < 2) key = `${key || "P"}0`; // grammar requires 2-10 chars
	return key.slice(0, 10);
}

// ---------- ULID ----------

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford
let lastTime = -1;
let lastRand: Uint8Array = new Uint8Array(10);

/** Monotonic ULID: time-ordered even for same-ms calls within this process. */
export function ulid(now = Date.now()): string {
	if (now === lastTime) {
		// increment the 80-bit random part
		for (let i = 9; i >= 0; i--) {
			if (lastRand[i] === 0xff) {
				lastRand[i] = 0;
			} else {
				(lastRand as Uint8Array)[i] = (lastRand[i] as number) + 1;
				break;
			}
		}
	} else {
		lastTime = now;
		lastRand = crypto.getRandomValues(new Uint8Array(10));
	}
	// 48-bit timestamp → 10 chars
	let t = now;
	const timeChars: string[] = [];
	for (let i = 0; i < 10; i++) {
		timeChars.unshift(B32[t % 32] as string);
		t = Math.floor(t / 32);
	}
	let out = timeChars.join("");
	// 80-bit randomness → 16 chars (encode 10 bytes, 5 bits at a time)
	let bits = 0;
	let acc = 0;
	for (const byte of lastRand) {
		acc = (acc << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(acc >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
	return out;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
