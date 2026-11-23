/**
 * Find the keys in a git config file that make git run a program or read
 * another config. Used by the probe's `exec_sweep` on config a sandbox could
 * have written.
 *
 * Host git already overrides these settings when it runs, so this is a second
 * layer: it stops a tampered gitdir from being attested as clean.
 *
 * A line this scanner cannot read is reported rather than skipped, because git
 * may read it differently. The key list is a denylist, so an executing key added
 * by a future git release is not covered until it is added here.
 */

/** `section.key`, for sections with no subsection or where it does not matter. */
const EXACT = new Set([
	"core.hookspath",
	"core.fsmonitor",
	"core.sshcommand",
	"core.gitproxy",
	"core.pager",
	"core.editor",
	"core.askpass",
	"core.worktree",
	"diff.external",
	"sequence.editor",
	"gpg.program",
	"web.browser",
	"uploadpack.packobjectshook",
	"credential.helper",
]);

/** Sections where every key is dangerous. */
const WHOLE_SECTION = new Set([
	"alias",
	"include",
	"includeif",
	"pager",
	"sendemail",
]);

/** `section.<name>.key`. */
const SUBSECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
	filter: new Set(["clean", "smudge", "process"]),
	diff: new Set(["textconv", "command"]),
	merge: new Set(["driver"]),
	remote: new Set(["uploadpack", "receivepack", "vcs"]),
	gpg: new Set(["program"]),
	credential: new Set(["helper"]),
	man: new Set(["cmd", "path"]),
	browser: new Set(["cmd", "path"]),
	difftool: new Set(["cmd", "path"]),
	mergetool: new Set(["cmd", "path"]),
	trailer: new Set(["command", "cmd"]),
	submodule: new Set(["update"]),
	protocol: new Set(["allow"]),
};

function isDangerous(
	section: string,
	subsection: string | null,
	key: string,
): boolean {
	if (WHOLE_SECTION.has(section)) return true;
	if (subsection === null) return EXACT.has(`${section}.${key}`);
	return SUBSECTION_KEYS[section]?.has(key) === true;
}

const HEADER = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]/;
const KEY = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(=|$|[#;])/;

/** Whether a value runs onto the next line, or null for an unterminated quote. */
function valueContinues(value: string): boolean | null {
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === "\\") {
			if (i === value.length - 1) return true;
			i++;
		} else if (c === '"') {
			quoted = !quoted;
		} else if (!quoted && (c === "#" || c === ";")) {
			return false;
		}
	}
	return quoted ? null : false;
}

/** The dangerous keys in `text`, plus one entry per line that cannot be read. */
export function dangerousGitKeys(text: string): string[] {
	const found: string[] = [];
	const lines = text.replace(/^﻿/, "").split("\n");
	let section: string | null = null;
	let subsection: string | null = null;
	for (let n = 0; n < lines.length; n++) {
		let rest = (lines[n] as string).replace(/\r$/, "").trimStart();
		let broken = false;
		// A header may share its line with the first key.
		while (rest.startsWith("[")) {
			const m = HEADER.exec(rest);
			if (!m) {
				broken = true;
				break;
			}
			const name = (m[1] as string).toLowerCase();
			const dot = name.indexOf(".");
			section = dot < 0 ? name : name.slice(0, dot);
			subsection = m[2] ?? (dot < 0 ? null : name.slice(dot + 1));
			rest = rest.slice(m[0].length).trimStart();
		}
		if (broken) {
			found.push(`unreadable line ${n + 1}`);
			continue;
		}
		if (rest === "" || rest.startsWith("#") || rest.startsWith(";")) continue;
		const m = KEY.exec(rest);
		if (!m || section === null) {
			found.push(`unreadable line ${n + 1}`);
			continue;
		}
		const key = (m[1] as string).toLowerCase();
		if (isDangerous(section, subsection, key)) {
			found.push(
				subsection === null ? `${section}.${key}` : `${section}.<name>.${key}`,
			);
		}
		if (m[2] !== "=") continue;
		let value = rest.slice(m[0].length);
		for (;;) {
			const more = valueContinues(value);
			if (more === null) found.push(`unreadable line ${n + 1}`);
			if (!more || n + 1 >= lines.length) break;
			n++;
			value = (lines[n] as string).replace(/\r$/, "");
		}
	}
	return found;
}
