import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";

/** Names inside a task's directory, beside `task.md`. Trivial enough to
 * inline rather than depend on anything for. */
const SPEC_FILE = "spec.md";
const ATTACHMENTS_DIR = "files";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The optional parts of a task directory: `spec.md` and `files/*`.
 *
 * Plain files beside `task.md`, outside the parsed/hashed task record so they
 * cannot make a task "malformed". Functions take the task directory; the
 * caller pins it against a title-driven rename (`TaskIndex.withTaskDir`).
 *
 * Caps are sanity limits: attachments are committed to the project branch, so
 * an unbounded upload is a permanent addition to history.
 */
export const CAPS = {
	/** A spec is a design note, not a manual. */
	specBytes: 256 * 1024,
	/** One attachment: a screenshot, a log, a small dataset. */
	attachmentBytes: 5 * 1024 * 1024,
	/** All of one task's attachments together. */
	attachmentsTotalBytes: 25 * 1024 * 1024,
	/** Attachments per task. */
	attachmentCount: 50,
} as const;

/** Refused input the caller should show as-is (maps to a 400, not a 500). */
export class ExtrasError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtrasError";
	}
}

/** What `getSpec` returns: the text and the token to save it back against. */
export interface SpecDoc {
	body: string;
	/** sha256 of the file's bytes; `""` when the task has no spec yet. */
	hash: string;
	exists: boolean;
}

export interface AttachmentInfo {
	name: string;
	size: number;
	/** Milliseconds since epoch. */
	modifiedAt: number;
}

// --- spec -------------------------------------------------------------------

export async function readSpec(dir: string): Promise<SpecDoc> {
	try {
		const body = await readFile(join(dir, SPEC_FILE), "utf8");
		return { body, hash: sha256(body), exists: true };
	} catch {
		return { body: "", hash: "", exists: false };
	}
}

/**
 * Write (or remove, when `body` is blank) the spec. `baseHash` is the hash the
 * caller last read; on mismatch returns null so the caller can surface the
 * current text instead of overwriting.
 */
export async function writeSpec(
	dir: string,
	body: string,
	baseHash: string | undefined,
): Promise<SpecDoc | null> {
	if (Buffer.byteLength(body, "utf8") > CAPS.specBytes) {
		throw new ExtrasError(
			`a spec is capped at ${CAPS.specBytes / 1024} KiB, split the work or link a file`,
		);
	}
	const current = await readSpec(dir);
	if (baseHash !== undefined && baseHash !== current.hash) return null;
	if (body.trim() === "") {
		await rm(join(dir, SPEC_FILE), { force: true });
		return { body: "", hash: "", exists: false };
	}
	await writeFileAtomic(join(dir, SPEC_FILE), body);
	return { body, hash: sha256(body), exists: true };
}

// --- attachments ------------------------------------------------------------

/**
 * An attachment name is a single, shell-safe path segment: no separators, no
 * leading dot (avoids `.tmp-*` scratch files and dotfiles), no NUL, bounded.
 * Rejected rather than rewritten, which would break the user's markdown link.
 */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._ +()@=,-]{0,119}$/;

export function assertAttachmentName(name: string): void {
	if (!NAME_RE.test(name) || name.includes("..")) {
		throw new ExtrasError(
			"attachment names must be 1-120 characters of letters, digits and " +
				"`._ +()@=,-`, starting with a letter, digit or underscore",
		);
	}
}

function attachmentsDir(dir: string): string {
	return join(dir, ATTACHMENTS_DIR);
}

export async function listAttachments(dir: string): Promise<AttachmentInfo[]> {
	let names: string[];
	try {
		names = await readdir(attachmentsDir(dir));
	} catch {
		return [];
	}
	const out: AttachmentInfo[] = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		try {
			const st = await stat(join(attachmentsDir(dir), name));
			if (!st.isFile()) continue;
			out.push({ name, size: st.size, modifiedAt: st.mtimeMs });
		} catch {
			// vanished between readdir and stat
		}
	}
	return out;
}

/** Add or replace one attachment, enforcing every cap before touching disk. */
export async function putAttachment(
	dir: string,
	name: string,
	bytes: Uint8Array,
): Promise<AttachmentInfo> {
	assertAttachmentName(name);
	if (bytes.byteLength === 0) throw new ExtrasError("attachment is empty");
	if (bytes.byteLength > CAPS.attachmentBytes) {
		throw new ExtrasError(
			`attachment is ${bytes.byteLength} bytes; the limit is ${CAPS.attachmentBytes / 1024 / 1024} MiB per file`,
		);
	}
	const existing = await listAttachments(dir);
	const replaced = existing.find((a) => a.name === name);
	if (!replaced && existing.length >= CAPS.attachmentCount) {
		throw new ExtrasError(
			`a task holds at most ${CAPS.attachmentCount} attachments`,
		);
	}
	const total =
		existing.reduce((n, a) => n + a.size, 0) -
		(replaced?.size ?? 0) +
		bytes.byteLength;
	if (total > CAPS.attachmentsTotalBytes) {
		throw new ExtrasError(
			`this would take the task's attachments to ${total} bytes; the limit is ${CAPS.attachmentsTotalBytes / 1024 / 1024} MiB in total`,
		);
	}
	await mkdir(attachmentsDir(dir), { recursive: true });
	await writeFileAtomic(join(attachmentsDir(dir), name), bytes);
	return { name, size: bytes.byteLength, modifiedAt: Date.now() };
}

export async function readAttachment(
	dir: string,
	name: string,
): Promise<Buffer | null> {
	assertAttachmentName(name);
	try {
		return await readFile(join(attachmentsDir(dir), name));
	} catch {
		return null;
	}
}

export async function deleteAttachment(
	dir: string,
	name: string,
): Promise<boolean> {
	assertAttachmentName(name);
	const path = join(attachmentsDir(dir), name);
	try {
		await stat(path);
	} catch {
		return false;
	}
	await rm(path, { force: true });
	// Remove an empty `files/`: git does not track empty dirs, so it would differ across checkouts.
	try {
		if ((await readdir(attachmentsDir(dir))).length === 0) {
			await rm(attachmentsDir(dir), { recursive: true, force: true });
		}
	} catch {
		// already gone
	}
	return true;
}
