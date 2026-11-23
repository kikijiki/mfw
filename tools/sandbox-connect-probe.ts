/**
 * Child of `auth-smoke.ts`: what a process in a real verifier-role sandbox
 * gets connecting to a unix socket. Built through the current launch path
 * (`buildVerifierProfile` -> `compileBwrap` -> `launchSandbox`) under real bwrap.
 * It never skips: a host that cannot run it prints a failure.
 *
 *   bun tools/sandbox-connect-probe.ts <scratch> <fake-home> <target-socket>
 *
 * Prints one JSON line `{ control, target }`, each "<kind>:<connect result>".
 * `control` is a socket the host listens on inside the sandbox's own tree: the
 * sandbox must see it as a socket ("socket:..."), so a missing target means the
 * path is not mounted, not that sockets cannot be seen. (Connecting to it gives
 * ECONNREFUSED: the sandbox has its own network namespace.) `target` is the
 * server's socket, which must be "ENOENT:ENOENT".
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { compileBwrap } from "../packages/daemon/src/containment/compile-bwrap.ts";
import * as hostCaps from "../packages/daemon/src/containment/host-caps.ts";
import { launchSandbox } from "../packages/daemon/src/containment/launch-sandbox.ts";
import { buildVerifierProfile } from "../packages/daemon/src/containment/role-profiles.ts";
import { discoverToolchain } from "../packages/daemon/src/containment/toolchain.ts";
import { requireHostTool } from "../packages/daemon/src/sandbox.ts";

const [scratch, fakeHome, target] = process.argv.slice(2) as [
	string,
	string,
	string,
];
if (!scratch || !fakeHome || !target) throw new Error("usage: see header");

const pass = <T>(value: T) => ({
	ok: true as const,
	severity: "required" as const,
	value,
	detail: "ok",
});

// A private run clone: <root>/tree, <root>/git, <root>/mfw-workspace.json.
const cloneRoot = realpathSync(join(scratch, "sandbox-clone"));
const tree = join(cloneRoot, "tree");
mkdirSync(tree, { recursive: true });
mkdirSync(join(cloneRoot, "git"), { recursive: true });
writeFileSync(join(cloneRoot, "mfw-workspace.json"), "{}");

// The positive control: a listener inside the tree the sandbox does see.
const control = net.createServer((c) => c.end());
await new Promise<void>((done) =>
	control.listen(join(tree, "control.sock"), done),
);
// The tree is bound at /work inside.
const controlPath = "/work/control.sock";

const readers = hostCaps.liveHostReaders();
const bwrapPath = requireHostTool("bwrap");
const [userns, bwrap] = await Promise.all([
	hostCaps.detectUserns(readers, {
		bwrap: bwrapPath,
		bwrapReal: realpathSync(bwrapPath),
		trueBin: requireHostTool("true"),
	}),
	hostCaps.detectBwrap(readers, bwrapPath),
]);
const binaries = ["bun", "sh"];
const toolchain = discoverToolchain({
	home: fakeHome,
	binaries,
	path: process.env.PATH ?? "",
	storeRoots: [realpathSync(process.execPath)],
});
const bunPath = toolchain.resolved.find(
	(b: { name: string; path: string }) => b.name === "bun",
)?.path;
if (!bunPath) throw new Error("bun is not in the sandbox toolchain");

const host = {
	caps: {
		userns,
		bwrap,
		// The scope is not used (`scope: "none"` below): bwrap is the subject.
		systemd: pass({
			hostKind: "native",
			manager: true,
			delegated: ["cpu", "memory", "pids"],
			missing: [],
		}),
		arch: hostCaps.detectArch(readers),
	},
	bwrapPath,
	envPath: requireHostTool("env"),
	systemdRunPath: "/unused/systemd-run",
	toolchain,
	home: fakeHome,
	mfwHome: join(scratch, "mfw"),
	allowedRoots: [cloneRoot],
	realpath: (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return null;
		}
	},
};

// "<what the path is>:<what connecting to it gave>".
const script = `const t=process.argv[1];let k;try{k=require("node:fs").statSync(t).isSocket()?"socket":"other"}catch(e){k=e.code}const s=require("node:net").connect(t);s.on("connect",()=>{console.log(k+":connected");process.exit(0)});s.on("error",e=>{console.log(k+":"+e.code);process.exit(0)})`;

async function connectFromSandbox(path: string): Promise<string> {
	const compiled = compileBwrap(
		buildVerifierProfile({ role: "verifier", tree, binaries }),
		[bunPath, "-e", script, path],
		host,
	);
	if (!compiled.ok) return `refused: ${compiled.reason}`;
	const child = launchSandbox(compiled, {
		approvalMode: "interactive",
		scope: "none",
	});
	(child.stdin as unknown as { end(): void }).end();
	const [out, err] = await Promise.all([
		new Response(child.stdout as unknown as ReadableStream).text(),
		new Response(child.stderr as unknown as ReadableStream).text(),
		child.exited,
	]);
	return out.trim() || `failed: ${err.trim()}`;
}

try {
	const result = {
		control: await connectFromSandbox(controlPath),
		target: await connectFromSandbox(target),
	};
	console.log(JSON.stringify(result));
} finally {
	control.close();
}
process.exit(0);
