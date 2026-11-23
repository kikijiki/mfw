import { describe, expect, test } from "bun:test";
import {
	DISABLE_USERNS_BWRAP_ARGS,
	writeSeccompFile,
} from "../src/containment/seccomp.ts";
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
	// X12: namespace, mount, inspection and handle calls, and flag-filtered ones
	"process_vm_readv",
	"kcmp",
	"setns",
	"mount",
	"open_by_handle_at",
	"clone_newuser",
	"unshare_newuser",
];

const PROBED = [...DISTINGUISHABLE, "userfaultfd", "clone3"];

function argv(seccomp: boolean, noUserns = false): string[] {
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
	if (noUserns) a.push(...DISABLE_USERNS_BWRAP_ARGS);
	if (seccomp) a.push("--seccomp", "3");
	return a;
}

async function inSandbox(
	cmd: string[],
	seccomp: boolean,
	noUserns = false,
): Promise<{ code: number; out: string; err: string }> {
	const f = seccomp ? writeSeccompFile() : null;
	try {
		const p = Bun.spawn([...argv(seccomp, noUserns), ...cmd], {
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
		const without = await inSandbox([BUN, PROBE, ...PROBED], false);
		expect(without.code).toBe(0);
		const base = errnos(without.out);
		for (const n of DISTINGUISHABLE) expect(base[n]).not.toBe(1);
		const withF = await inSandbox([BUN, PROBE, ...PROBED], true);
		expect(withF.code).toBe(0);
		const filtered = errnos(withF.out);
		for (const n of [...DISTINGUISHABLE, "userfaultfd"])
			expect(filtered[n]).toBe(1);
		expect(filtered.clone3).toBe(38); // ENOSYS
	});

	test("X12: a nested user namespace and ptrace work without the filter and are refused with it", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		const nested = ["unshare", "--user", "true"];
		if (!Bun.which("unshare")) return console.log("skip: no unshare");
		const without = await inSandbox(nested, false);
		if (without.code !== 0)
			return console.log("skip: host already forbids nested user namespaces");
		const withF = await inSandbox(nested, true);
		expect(withF.code).not.toBe(0);
		expect(withF.err).toMatch(/not permitted/i);
		// the ptrace probe reaches the kernel unfiltered (0 = TRACEME worked)
		const base = errnos((await inSandbox([BUN, PROBE, "ptrace"], false)).out);
		expect(base.ptrace).not.toBe(1);
		const filtered = errnos(
			(await inSandbox([BUN, PROBE, "ptrace"], true)).out,
		);
		expect(filtered.ptrace).toBe(1);
	});

	test("AF_VSOCK and friends are refused by the filter, without reaching the kernel", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		// An invalid type makes an unfiltered kernel answer EINVAL before it
		// would autoload a protocol module, so this can load nothing.
		const script = `import { dlopen, FFIType, read } from "bun:ffi";
const l = dlopen("libc.so.6", { syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 }, __errno_location: { args: [], returns: FFIType.ptr } });
for (const f of [40, 17, 38, 1, 2, 10]) { l.symbols.syscall(41, f, 0x40000001, 0); console.log(f + " " + read.i32(l.symbols.__errno_location())); }`;
		const parse = (out: string) =>
			Object.fromEntries(
				out
					.trim()
					.split("\n")
					.map((l) => l.split(" ")),
			);
		const without = await inSandbox([BUN, "-e", script], false);
		expect(without.code).toBe(0);
		for (const f of ["40", "17", "38"])
			expect(parse(without.out)[f]).toBe("22");
		const withF = await inSandbox([BUN, "-e", script], true);
		expect(withF.code).toBe(0);
		const got = parse(withF.out);
		for (const f of ["40", "17", "38"]) expect(got[f]).toBe("97");
		for (const f of ["1", "2", "10"]) expect(got[f]).toBe("22");
	});

	test("X12: --disable-userns on its own also blocks the nested namespace", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		if (!Bun.which("unshare")) return console.log("skip: no unshare");
		const r = await inSandbox(["unshare", "--user", "true"], true, true);
		if (r.err.includes("disable-userns"))
			return console.log(
				`skip: bwrap lacks --disable-userns (${r.err.trim()})`,
			);
		expect(r.code).not.toBe(0);
	});

	test("ordinary tools still run under the filter", async () => {
		const why = await skipReason();
		if (why) return console.log(`skip: ${why}`);
		const tools: string[][] = [
			[BUN, "-e", "console.log(1+1)"],
			["sh", "-c", "echo ok"],
			["sh", "-c", "echo ok | cat; (echo sub)"],
		];
		const python = Bun.which("python3");
		if (python)
			tools.push([
				python,
				"-c",
				"import subprocess,threading;t=threading.Thread(target=lambda:0);t.start();t.join();print(subprocess.check_output(['echo','x']))",
			]);
		tools.push([
			BUN,
			"-e",
			"const p=Bun.spawnSync(['echo','x']);if(p.exitCode)process.exit(1);await Bun.sleep(5);new Worker('data:text/javascript,postMessage(1)');",
		]);
		for (const bin of ["git", "node"]) {
			const p = Bun.which(bin);
			if (p) tools.push([p, "--version"]);
		}
		const node = Bun.which("node");
		if (node)
			tools.push([
				node,
				"-e",
				"require('child_process').execSync('echo hi');new (require('worker_threads').Worker)('1',{eval:true}).on('exit',()=>{})",
			]);
		const git = Bun.which("git");
		if (git) tools.push([git, "hash-object", "--stdin"]);
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
