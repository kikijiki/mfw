import { sanitizeText } from "./report.ts";

/**
 * Printed fixes get pasted into a root shell, so a value is either quoted so
 * the shell sees it as one literal argument, or it is not printed in a command.
 */

/** POSIX single quoting: nothing inside is expanded. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const UNPRINTABLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
	/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

/**
 * Whether this value survives printing unchanged. A control character or a
 * redacted run would make the printed command name a different path.
 */
export function printableInCommand(value: string): boolean {
	return !UNPRINTABLE.test(value) && sanitizeText(value) === value;
}

/** `build` with each path quoted, or advice to rename when one cannot be printed. */
export function commandFor(
	paths: readonly string[],
	build: (quoted: string) => string,
): string {
	if (!paths.every(printableInCommand)) {
		return "rename the path first: it contains control characters or a token-like string, so no command can be printed for it safely";
	}
	return build(paths.map(shellQuote).join(" "));
}

/** Trees where a printed chown or chmod could damage the system. */
const SYSTEM_TREES = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/lib",
	"/lib32",
	"/lib64",
	"/nix",
	"/proc",
	"/run",
	"/sbin",
	"/sys",
	"/usr",
];
const SYSTEM_DIRS = new Set([
	"/",
	"/home",
	"/media",
	"/mnt",
	"/opt",
	"/root",
	"/srv",
	"/tmp",
	"/var",
	"/var/lib",
]);

/** A path no fix should change ownership or mode of, whatever it contains. */
export function isSystemPath(path: string): boolean {
	const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
	return (
		SYSTEM_DIRS.has(p) ||
		SYSTEM_TREES.some((t) => p === t || p.startsWith(`${t}/`))
	);
}
