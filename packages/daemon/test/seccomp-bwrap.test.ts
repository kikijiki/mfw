import { describe, expect, test } from "bun:test";
import { writeSeccompFile } from "../src/containment/seccomp.ts";
import { bwrapAvailable } from "../src/sandbox.ts";

const PROBE = new URL("../src/containment/syscall-probe.ts", import.meta.url)
	.pathname;
const BUN = process.execPath;
// userfaultfd answers EPERM on hosts with vm.unprivileged_userfaultfd=0 even
// without a filter, so it cannot show the difference; the rest can.
const DISTINGUISHABLE = [
	"io_uring_setup",
	"io_uring_enter",
	"io_uring_register",
	"bpf",
	"perf_event_open",
	"keyctl",
	"add_key",
	"request_key",
];

function argv(seccomp: boolean): string[] {
	const a = [
		"bwrap",
		"--unshare-all",
		"--unshare-user",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
	];
	if (seccomp) a.push("--seccomp", "3");
	return a;
}

async function inSandbox(
	cmd: string[],
	seccomp: boolean,
): Promise<{ code: number; out: string; err: string }> {
	const f = seccomp ? writeSeccompFile() : null;
	try {
		const p = Bun.spawn([...argv(seccomp), ...cmd], {
			stdio: ["ignore", "pipe", "pipe", ...(f ? [f.stdio] : [])] as never,
			env: { PATH: process.env.PATH ?? "" },
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { code, out, err };
	} finally {
		f?.cleanup();
	}
}

async function skipReason(): Promise<string | null> {
	if (process.arch !== "x64") return "not x86_64";
	if (!(await bwrapAvailable())) return "no bwrap";
	const r = await inSandbox(["true"], false);
	return r.code === 0 ? null : `bwrap cannot run here (${r.err.trim()})`;
}

function errnos(out: string): Record<string, number> {
	return Object.fromEntries(
		out
			.trim()
			.split("\n")
			.map((l) => {
				const [n, e] = l.split(" ");
				return [n, Number(e)];
			}),
	);
}

describe("seccomp under bwrap", () => {
	test("the filter turns the denied syscalls into EPERM; without it they are not EPERM", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		const without = await inSandbox([BUN, PROBE], false);
		expect(without.code).toBe(0);
		const base = errnos(without.out);
		for (const n of DISTINGUISHABLE) expect(base[n]).not.toBe(1);
		const withF = await inSandbox([BUN, PROBE], true);
		expect(withF.code).toBe(0);
		const filtered = errnos(withF.out);
		for (const n of [...DISTINGUISHABLE, "userfaultfd"])
			expect(filtered[n]).toBe(1);
	});

	test("ordinary tools still run under the filter", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		const tools: string[][] = [
			[BUN, "-e", "console.log(1+1)"],
			["sh", "-c", "echo ok"],
		];
		for (const bin of ["git", "node"]) {
			const p = Bun.which(bin);
			if (p) tools.push([p, "--version"]);
		}
		for (const t of tools) {
			const r = await inSandbox(t, true);
			expect(`${t[0]}: ${r.code} ${r.err}`).toBe(`${t[0]}: 0 `);
		}
	});

	test("the filter is active in the sandbox (Seccomp: 2)", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		const r = await inSandbox(["grep", "^Seccomp:", "/proc/self/status"], true);
		expect(r.out).toMatch(/Seccomp:\s+2/);
	});
});
