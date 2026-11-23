import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_DEPTH_ENV } from "../src/run-child.ts";

const PARENT = join(import.meta.dir, "fixtures/forward-parent.ts");
const dirs: string[] = [];
const started: { pid: number }[] = [];

/** Every live descendant of this process, read from /proc. */
function descendants(): number[] {
	const parentOf = new Map<number, number>();
	for (const e of readdirSync("/proc")) {
		if (!/^\d+$/.test(e)) continue;
		try {
			const stat = readFileSync(`/proc/${e}/stat`, "utf8");
			const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			parentOf.set(Number(e), Number(after[1]));
		} catch {
			// gone
		}
	}
	const out: number[] = [];
	const walk = (pid: number) => {
		for (const [c, p] of parentOf) {
			if (p === pid) {
				out.push(c);
				walk(c);
			}
		}
	};
	walk(process.pid);
	return out;
}

function killTree() {
	for (const pid of descendants()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	}
}

// Watchdog: more than 20 descendants means something is multiplying.
const watchdog = setInterval(() => {
	if (descendants().length > 20) {
		killTree();
		console.error("run-child.test watchdog: >20 descendants, killed them");
		process.exit(99);
	}
}, 100);

afterEach(() => {
	killTree();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	started.length = 0;
});
process.on("exit", () => clearInterval(watchdog));

function tmp(): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-fwd-")));
	dirs.push(d);
	return d;
}

/**
 * A fake server: records its own start in a counter file, exits at once with
 * an error if that counter is above 3, prints ready, then behaves per `body`.
 * It always ends itself after 8 s.
 */
function fakeChild(dir: string, body: string): string {
	const p = join(dir, "child.ts");
	writeFileSync(
		p,
		`import { appendFileSync, readFileSync } from "node:fs";
const counter = process.env.MFW_FWD_COUNTER as string;
appendFileSync(counter, "x");
if (readFileSync(counter, "utf8").length > 3) process.exit(98);
setTimeout(() => process.exit(97), 8000);
console.log("ready");
${body}
`,
	);
	return p;
}

/** Reads stdout until `needle` shows up; `rest()` reads the remainder. */
function reader(stream: ReadableStream<Uint8Array>) {
	const r = stream.getReader();
	const dec = new TextDecoder();
	let seen = "";
	const pull = async (until: string | null): Promise<string> => {
		for (;;) {
			if (until !== null && seen.includes(until)) return seen;
			const { done, value } = await r.read();
			if (done) return seen;
			seen += dec.decode(value);
		}
	};
	return { waitFor: (n: string) => pull(n), rest: () => pull(null) };
}

function launch(dir: string, child: string, env: Record<string, string> = {}) {
	const counter = join(dir, "counter");
	writeFileSync(counter, "");
	return {
		counter,
		p: Bun.spawn(
			[process.execPath, "run", PARENT, process.execPath, "run", child],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, MFW_FWD_COUNTER: counter, ...env },
			},
		),
	};
}

const starts = (counter: string) => readFileSync(counter, "utf8").length;

describe("runForwarding", () => {
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		test(`${sig} reaches the child, the parent waits and exits with the child's code`, async () => {
			const dir = tmp();
			const child = fakeChild(
				dir,
				`process.on("${sig}", () => { console.log("child-got-${sig}"); process.exit(42); });\nsetInterval(() => {}, 1000);`,
			);
			const { p, counter } = launch(dir, child);
			const out = reader(p.stdout);
			const head = await out.waitFor("ready");
			expect(head).toContain("ready");
			p.kill(sig);
			const rest = await out.rest();
			expect(await p.exited).toBe(42);
			expect(rest).toContain(`child-got-${sig}`);
			expect(rest).toContain("parent-exit 42");
			expect(starts(counter)).toBe(1);
		}, 15_000);
	}

	test("a child that exits on its own propagates its code", async () => {
		const dir = tmp();
		const { p } = launch(dir, fakeChild(dir, "process.exit(7);"));
		expect(await p.exited).toBe(7);
	}, 15_000);

	test("a child killed by a signal exits 128 + the signal", async () => {
		const dir = tmp();
		const { p } = launch(
			dir,
			fakeChild(dir, 'process.kill(process.pid, "SIGKILL");'),
		);
		expect(await p.exited).toBe(137);
	}, 15_000);

	test("a child that cannot start is a clean failure, not a hang", async () => {
		const p = Bun.spawn(
			[process.execPath, "run", PARENT, "/nonexistent/mfw-child"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await p.exited).toBe(127);
	}, 15_000);

	test("recursion guard: a process mfw already started refuses to spawn again", async () => {
		const dir = tmp();
		const { p, counter } = launch(dir, fakeChild(dir, "process.exit(0);"), {
			[CHILD_DEPTH_ENV]: "1",
		});
		expect(await p.exited).toBe(1);
		expect(await new Response(p.stderr).text()).toContain("refusing to start");
		expect(starts(counter)).toBe(0);
		expect(existsSync(counter)).toBe(true);
	}, 15_000);

	test("the child is marked, so a child that re-enters the launcher is refused", async () => {
		const dir = tmp();
		// The child itself runs the parent fixture: depth 2 must be refused.
		const inner = fakeChild(dir, "process.exit(0);");
		const outer = join(dir, "outer.ts");
		writeFileSync(
			outer,
			`import { appendFileSync } from "node:fs";
appendFileSync(process.env.MFW_FWD_COUNTER as string, "o");
setTimeout(() => process.exit(97), 8000);
const p = Bun.spawn([process.execPath, "run", ${JSON.stringify(PARENT)}, process.execPath, "run", ${JSON.stringify(inner)}], { stdout: "inherit", stderr: "inherit" });
process.exit(await p.exited);
`,
		);
		const { p, counter } = launch(dir, outer);
		expect(await p.exited).toBe(1);
		expect(starts(counter)).toBe(1);
	}, 15_000);
});
