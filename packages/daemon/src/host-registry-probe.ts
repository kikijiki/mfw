import {
	type HostConfig,
	type HostObservation,
	REMOTE_HARNESSES,
} from "./host-registry.ts";
import { RemoteTransportError } from "./ssh-transport.ts";

/**
 * One SSH round trip that reports what a registry host can do and whether it
 * meets the trust minimum. Read-only on the box: it creates nothing, and the
 * only privileged thing it does is ask `sudo -n true`, which must FAIL.
 *
 * Output is `key=value` lines after a marker, so a chatty login shell
 * (motd, profile echo) cannot be mistaken for a probe answer.
 */

const MARKER = "MFW_HOST_PROBE_V1";

function q(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hostProbeScript(): string {
	const harnessLines = Object.entries(REMOTE_HARNESSES).flatMap(([id, h]) => [
		`if command -v ${h.binary} >/dev/null 2>&1; then printf 'harness.${id}=%s\\n' "$(${h.binary} --version 2>/dev/null | head -n1 | tr -d '\\r')"; else printf 'harness.${id}=\\n'; fi`,
		`a=no; for f in ${h.authPaths.map((p) => `"$HOME"/${q(p)}`).join(" ")}; do [ -s "$f" ] && a=yes; done; printf 'auth.${id}=%s\\n' "$a"`,
	]);
	return [
		"set -u",
		// The login PATH is where installers put claude/codex/bun.
		`lp=$(sh -lc 'printf "\\nMFW_LOGIN_PATH=%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^MFW_LOGIN_PATH=//p' | tail -n1)`,
		'if [ -n "$lp" ]; then PATH="$lp:$PATH"; fi',
		'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
		"export PATH",
		`printf '%s\\n' ${MARKER}`,
		`printf 'uid=%s\\n' "$(id -u)"`,
		`printf 'user=%s\\n' "$(id -un)"`,
		`printf 'home=%s\\n' "$HOME"`,
		`printf 'path=%s\\n' "$PATH"`,
		"if sudo -n true >/dev/null 2>&1; then echo sudo=allowed; else echo sudo=refused; fi",
		`printf 'bwrap.path=%s\\n' "$(command -v bwrap || true)"`,
		"if command -v bwrap >/dev/null 2>&1 && bwrap --die-with-parent --ro-bind / / --dev /dev --proc /proc true >/dev/null 2>&1; then echo bwrap=yes; else echo bwrap=no; fi",
		`printf 'setsid=%s\\n' "$(command -v setsid || true)"`,
		`printf 'bun=%s\\n' "$(command -v bun || true)"`,
		`printf 'git=%s\\n' "$(command -v git || true)"`,
		...harnessLines,
		`printf 'gpus=%s\\n' "$( (nvidia-smi -L 2>/dev/null || true) | grep -c '^GPU' )"`,
		`printf 'disk.kib=%s\\n' "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"`,
		`printf 'mem.kib=%s\\n' "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"`,
	].join("\n");
}

function parseLines(stdout: string): Map<string, string> | null {
	const lines = stdout.split("\n");
	const start = lines.indexOf(MARKER);
	if (start < 0) return null;
	const out = new Map<string, string>();
	for (const line of lines.slice(start + 1)) {
		const eq = line.indexOf("=");
		if (eq > 0) out.set(line.slice(0, eq), line.slice(eq + 1).trim());
	}
	return out;
}

function absolute(value: string | undefined): string | null {
	return value?.startsWith("/") ? value : null;
}

function kib(value: string | undefined): number | null {
	return value && /^\d+$/.test(value) ? Number(value) * 1024 : null;
}

/**
 * Judge one probe answer against the host's declared trust. Pure, so the
 * refusal rules are tested without SSH.
 */
export function assessHostProbe(
	config: Pick<HostConfig, "trust" | "sandbox" | "user">,
	stdout: string,
	checkedAt: number,
): HostObservation {
	const values = parseLines(stdout);
	if (!values) {
		return unreachableObservation(checkedAt, "the probe returned no answer");
	}
	const uidText = values.get("uid") ?? "";
	const uid = /^\d+$/.test(uidText) ? Number(uidText) : null;
	const sudoText = values.get("sudo");
	const sudo =
		sudoText === "allowed" || sudoText === "refused" ? sudoText : "unknown";
	const bwrap = values.get("bwrap") === "yes";
	const harnesses: HostObservation["harnesses"] = {};
	for (const id of Object.keys(REMOTE_HARNESSES)) {
		const version = values.get(`harness.${id}`) || null;
		harnesses[id] = { version, auth: values.get(`auth.${id}`) === "yes" };
	}
	const observation: HostObservation = {
		checkedAt,
		health: "ok",
		problems: [],
		uid,
		user: values.get("user") || null,
		home: absolute(values.get("home")),
		path: values.get("path") || null,
		bunPath: absolute(values.get("bun")),
		gitPath: absolute(values.get("git")),
		setsidPath: absolute(values.get("setsid")),
		bwrapPath: absolute(values.get("bwrap.path")),
		sudo,
		bwrap,
		harnesses,
		gpus: Number(values.get("gpus") ?? "0") || 0,
		diskFreeBytes: kib(values.get("disk.kib")),
		memAvailableBytes: kib(values.get("mem.kib")),
	};

	const refused: string[] = [];
	if (uid === null) refused.push("could not read the user id");
	if (uid === 0) refused.push("the SSH user is root");
	if (observation.user && observation.user !== config.user)
		refused.push(
			`logged in as '${observation.user}', not the declared '${config.user}'`,
		);
	if (sudo === "allowed")
		refused.push(
			"passwordless sudo works (sudo -n true succeeded): use a dedicated user without sudo",
		);
	if (sudo === "unknown") refused.push("could not check sudo");
	if (config.sandbox === "bwrap" && !bwrap)
		refused.push(
			config.trust === "shared"
				? "bwrap is mandatory on a shared host but is missing or unusable (install bubblewrap, allow unprivileged user namespaces)"
				: "sandbox is bwrap but bwrap is missing or unusable (install it, or set sandbox: none on an owned host)",
		);
	if (!observation.home) refused.push("the user has no absolute $HOME");

	const missing: string[] = [];
	if (!observation.bunPath) missing.push("bun is not installed for this user");
	if (!observation.gitPath) missing.push("git is not installed");
	if (!observation.setsidPath) missing.push("setsid (util-linux) is missing");

	observation.problems = [...refused, ...missing];
	observation.health =
		refused.length > 0 ? "refused" : missing.length > 0 ? "error" : "ok";
	return observation;
}

export function unreachableObservation(
	checkedAt: number,
	problem: string,
): HostObservation {
	return {
		checkedAt,
		health: "unreachable",
		problems: [problem],
		uid: null,
		user: null,
		home: null,
		path: null,
		bunPath: null,
		gitPath: null,
		setsidPath: null,
		bwrapPath: null,
		sudo: "unknown",
		bwrap: false,
		harnesses: {},
		gpus: 0,
		diskFreeBytes: null,
		memAvailableBytes: null,
	};
}

/** The one call a probe needs from a transport. */
export interface ProbeTransport {
	run(
		command: readonly string[],
		opts?: { timeoutMs?: number },
	): Promise<{ stdout: string }>;
}

export async function probeHost(
	config: Pick<HostConfig, "trust" | "sandbox" | "user">,
	transport: ProbeTransport,
	now: () => number = Date.now,
): Promise<HostObservation> {
	try {
		const result = await transport.run(["/bin/sh", "-c", hostProbeScript()], {
			timeoutMs: 30_000,
		});
		return assessHostProbe(config, result.stdout, now());
	} catch (error) {
		const reason =
			error instanceof RemoteTransportError
				? error.failure === "identity_mismatch"
					? `refused the connection: ${error.message}`
					: error.failure === "remote_exit"
						? "the probe script failed on the box"
						: "could not connect over SSH (check address, port, the authorized key and the pinned host key)"
				: error instanceof Error
					? error.message
					: String(error);
		return unreachableObservation(now(), reason);
	}
}
