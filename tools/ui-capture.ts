#!/usr/bin/env bun
/**
 * ui-capture: drive the web UI in a real (headless) Firefox and screenshot
 * every main screen at three viewports, collecting console errors and failed
 * requests per screen. Zero dependencies: it speaks WebDriver BiDi directly to
 * the system `firefox` (Firefox >= 130).
 *
 *   bun tools/ui-capture.ts [--base http://127.0.0.1:7777/mfw] [--out DIR]
 *       [--projects dummy-todo,dummy-notes,dummy-plan] [--sizes 1920x1080,...]
 *       [--only substring] [--docs adr/MFW-ADR-1,docs/intro.md] [--firefox /path/to/firefox]
 *
 * Output: DIR/<viewport>/<screen>.png plus DIR/report.json and a printed
 * summary of console errors / failed requests. It is read-only against the
 * daemon: it navigates and opens dialogs, it never submits anything.
 * Task-level screens use the first task link found on each project's board.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1]
		? (process.argv[i + 1] as string)
		: fallback;
}

const BASE = arg("base", "http://127.0.0.1:7777/mfw").replace(/\/$/, "");
const OUT = arg("out", join(tmpdir(), "mfw-ui-capture"));
const PROJECTS = arg("projects", "dummy-todo,dummy-notes,dummy-plan").split(
	",",
);
const SIZES = arg("sizes", "1920x1080,1440x900,390x844")
	.split(",")
	.map((s) => {
		const [w, h] = s.split("x").map(Number);
		return { w: w as number, h: h as number, name: s };
	});
const ONLY = arg("only", "");
/** Extra Docs locations to capture, relative to /p/<project>/docs (`adr/MFW-ADR-1,docs/intro.md`). */
const DOCS = arg("docs", "")
	.split(",")
	.filter((d) => d.length > 0);
const FIREFOX = arg("firefox", "firefox");

// ---- minimal BiDi client -------------------------------------------------

type Json = Record<string, unknown>;
class Bidi {
	private id = 0;
	private pending = new Map<
		number,
		{ ok: (v: Json) => void; fail: (e: Error) => void }
	>();
	private listeners: Array<(method: string, params: Json) => void> = [];
	private constructor(private ws: WebSocket) {
		ws.onmessage = (ev) => {
			const msg = JSON.parse(String(ev.data)) as Json;
			if (typeof msg.id === "number") {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.type === "error")
					p.fail(new Error(`${msg.error}: ${msg.message}`));
				else p.ok((msg.result ?? {}) as Json);
			} else if (msg.type === "event") {
				for (const l of this.listeners)
					l(msg.method as string, (msg.params ?? {}) as Json);
			}
		};
	}
	static async connect(url: string): Promise<Bidi> {
		for (let i = 0; i < 60; i++) {
			try {
				const ws = new WebSocket(url);
				await new Promise<void>((ok, fail) => {
					ws.onopen = () => ok();
					ws.onerror = () => fail(new Error("ws"));
				});
				return new Bidi(ws);
			} catch {
				await Bun.sleep(250);
			}
		}
		throw new Error(`could not connect to ${url}`);
	}
	send(method: string, params: Json = {}): Promise<Json> {
		const id = ++this.id;
		return new Promise((ok, fail) => {
			this.pending.set(id, { ok, fail });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	on(fn: (method: string, params: Json) => void) {
		this.listeners.push(fn);
	}
	close() {
		this.ws.close();
	}
}

// ---- browser -------------------------------------------------------------

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "mfw-ui-capture-ff-"));
const ff = spawn(
	FIREFOX,
	[
		"--headless",
		"--no-remote",
		"--remote-debugging-port",
		String(port),
		"--profile",
		profile,
		"about:blank",
	],
	{ stdio: "ignore" },
);
let shuttingDown = false;
const cleanup = () => {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		ff.kill("SIGTERM");
	} catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
	cleanup();
	process.exit(130);
});

const bidi = await Bidi.connect(`ws://127.0.0.1:${port}/session`);
await bidi.send("session.new", { capabilities: {} });
await bidi.send("session.subscribe", {
	events: [
		"log.entryAdded",
		"network.responseCompleted",
		"network.fetchError",
		"browsingContext.userPromptOpened",
	],
});
const tree = (await bidi.send("browsingContext.getTree")) as {
	contexts: Array<{ context: string }>;
};
const ctx = (tree.contexts[0] as { context: string }).context;

let issues: string[] = [];
let sawProbe = false;
bidi.on((method, p) => {
	if (method === "browsingContext.userPromptOpened") {
		// A beforeunload ("leave site?") prompt would hang the next navigation.
		issues.push(`user prompt: ${p.type} ${String(p.message ?? "")}`);
		void bidi.send("browsingContext.handleUserPrompt", {
			context: ctx,
			accept: true,
		});
		return;
	}
	if (method === "log.entryAdded") {
		if (String(p.text).includes("ui-capture-probe")) sawProbe = true;
		const level = p.level as string;
		if (level === "error" || level === "warning") {
			issues.push(`console.${level}: ${String(p.text).slice(0, 300)}`);
		}
	} else if (method === "network.responseCompleted") {
		const res = p.response as { status: number; url: string };
		if (res.status >= 400) issues.push(`HTTP ${res.status}: ${res.url}`);
	} else if (method === "network.fetchError") {
		const req = p.request as { url: string };
		// Aborted streams are just navigation tearing down live.events.
		if (!String(p.errorText).includes("ABORTED"))
			issues.push(`fetch error: ${p.errorText} ${req.url}`);
	}
});

async function evalJs<T = unknown>(expression: string): Promise<T> {
	const r = (await bidi.send("script.evaluate", {
		expression: `(async()=>{ const v = await (${expression}); return JSON.stringify(v ?? null); })()`,
		target: { context: ctx },
		awaitPromise: true,
	})) as {
		type: string;
		result?: { value?: string };
		exceptionDetails?: { text: string };
	};
	if (r.type === "exception")
		throw new Error(r.exceptionDetails?.text ?? "script error");
	return JSON.parse(r.result?.value ?? "null") as T;
}

/** Prove console capture works, so "no errors" in the report means something. */
async function probeConsole() {
	await evalJs(`(console.error("ui-capture-probe"), 1)`);
	await Bun.sleep(300);
	if (!sawProbe)
		console.warn(
			"WARNING: console events are not reaching the capture; 'no errors' is not trustworthy",
		);
	issues = [];
}

async function setViewport(w: number, h: number) {
	await bidi.send("browsingContext.setViewport", {
		context: ctx,
		viewport: { width: w, height: h },
	});
}

async function goto(path: string) {
	// A wedged dev server must not hang the whole run.
	await Promise.race([
		bidi.send("browsingContext.navigate", {
			context: ctx,
			url: `${BASE}${path}`,
			wait: "complete",
		}),
		Bun.sleep(45_000).then(() =>
			console.warn(`  (navigation to ${path} timed out)`),
		),
	]);
	// Hydrated = React mounted something beyond the SSR skeleton and the page went quiet.
	await settle();
}

async function settle(ms = 1200) {
	await Bun.sleep(300);
	await evalJs(`new Promise(r => {
		let last = performance.now(); let n = document.querySelectorAll('*').length;
		const tick = () => { const m = document.querySelectorAll('*').length;
			if (m !== n) { n = m; last = performance.now(); }
			if (performance.now() - last > ${ms} || performance.now() > 15000) r(1); else setTimeout(tick, 150); };
		tick(); })`);
}

async function key(chord: string[]) {
	const named: Record<string, string> = {
		Control: "",
		Escape: "",
		Enter: "",
		Tab: "",
	};
	const v = (k: string) => named[k] ?? k;
	const actions = chord.map((k) => ({ type: "keyDown", value: v(k) }));
	const ups = [...chord].reverse().map((k) => ({ type: "keyUp", value: v(k) }));
	await bidi.send("input.performActions", {
		context: ctx,
		actions: [{ type: "key", id: "kb", actions: [...actions, ...ups] }],
	});
}

/** Click the first element whose visible text matches, within an optional scope selector. */
async function clickText(
	text: string,
	selector = "button,a,[role=tab],[role=button]",
): Promise<boolean> {
	return evalJs<boolean>(`(() => {
		const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
		const el = els.find(e => (e.textContent||'').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())})
			|| (e.getAttribute('aria-label')||'').toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
		if (!el) return false; el.click(); return true; })()`);
}

await probeConsole();

const report: Record<
	string,
	{ file: string; issues: string[]; overflowX: boolean; note?: string }
> = {};

async function shot(
	size: { name: string; w: number; h: number },
	screen: string,
	opts: { full?: boolean; note?: string } = {},
) {
	const note = opts.note;
	await Bun.sleep(400);
	const dir = join(OUT, size.name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${screen}.png`);
	// The app scrolls inside its shell, so a "full page" shot is a tall viewport.
	if (opts.full) await setViewport(size.w, 3200);
	if (opts.full) await Bun.sleep(500);
	const r = (await bidi.send("browsingContext.captureScreenshot", {
		context: ctx,
		origin: "viewport",
	})) as {
		data: string;
	};
	writeFileSync(file, Buffer.from(r.data, "base64"));
	if (opts.full) await setViewport(size.w, size.h);
	const overflowX = await evalJs<boolean>(
		"document.documentElement.scrollWidth > document.documentElement.clientWidth + 1",
	);
	const key = `${size.name}/${screen}`;
	report[key] = {
		file,
		issues: [...new Set(issues)],
		overflowX,
		...(note ? { note } : {}),
	};
	issues = [];
	process.stdout.write(
		`  ${key}${overflowX ? "  [H-OVERFLOW]" : ""}${report[key]?.issues.length ? `  (${report[key]?.issues.length} issues)` : ""}\n`,
	);
}

// ---- the screens ---------------------------------------------------------

async function firstTaskHref(): Promise<string | null> {
	return evalJs<string | null>(`(() => {
		const a = [...document.querySelectorAll('a[href]')].find(a => /\\/tasks\\/[^/?#]+/.test(a.getAttribute('href')||''));
		return a ? a.getAttribute('href') : null; })()`);
}

const want = (name: string) => !ONLY || name.includes(ONLY);

for (const size of SIZES) {
	console.log(`== ${size.name}`);
	await setViewport(size.w, size.h);

	if (want("home")) {
		await goto("/");
		await shot(size, "home");
	}
	// The sidebar in both widths, plus a project's action menu (desktop only).
	if (want("sidebar") && size.w >= 768) {
		const setPref = (v: string) =>
			evalJs(
				`(localStorage.setItem("mfw:v2:sidebar", ${JSON.stringify(v)}), 1)`,
			);
		await goto("/");
		await setPref("expanded");
		await goto("/");
		await shot(size, "sidebar-expanded");
		await setPref("collapsed");
		await goto("/");
		await shot(size, "sidebar-collapsed");
		const opened = await evalJs<boolean>(`(() => {
			const t = document.querySelector('[data-testid="project-tile"] a');
			if (!t) return false;
			t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			return true; })()`);
		await Bun.sleep(500);
		await shot(size, "sidebar-collapsed-menu", {
			note: opened ? undefined : "no project tile found",
		});
		// A project open: its tile/row must wear the selection as a whole.
		await goto(`/p/${PROJECTS[0]}/board`);
		await shot(size, "sidebar-collapsed-project");
		await setPref("expanded");
		await goto(`/p/${PROJECTS[0]}/board`);
		await shot(size, "sidebar-expanded-project");
	}
	for (const [name, path] of [
		["models", "/models"],
		["resources", "/resources"],
		["runpod", "/runpod"],
		["openrouter", "/openrouter"],
		["settings", "/settings"],
	] as const) {
		if (!want(name)) continue;
		await goto(path);
		await shot(size, name);
	}
	if (want("palette")) {
		await goto("/");
		await key(["Control", "k"]);
		await Bun.sleep(500);
		await shot(size, "palette");
		await key(["Escape"]);
	}
	if (want("addproject")) {
		await goto("/");
		if (await clickText("add project")) {
			await Bun.sleep(600);
			await shot(size, "addproject-1");
			// Pick the first repository the browser offers (selection is local state only).
			await clickText("select", "[role=dialog] button");
			await Bun.sleep(400);
			if (await clickText("next: board", "[role=dialog] button")) {
				await Bun.sleep(600);
				await shot(size, "addproject-2");
			}
			await key(["Escape"]);
		} else
			report[`${size.name}/addproject`] = {
				file: "",
				issues: ["no 'Add project' control found"],
				overflowX: false,
			};
	}

	for (const project of PROJECTS) {
		const p = `/p/${project}`;
		if (want("board")) {
			await goto(`${p}/board`);
			await shot(size, `${project}-board`);
		}
		const task = await firstTaskHref();
		if (want("flow")) {
			await goto(`${p}/flow`);
			await shot(size, `${project}-flow`);
		}
		if (task && want("task")) {
			const path = task.replace(/^\/mfw/, "");
			await goto(path);
			await shot(size, `${project}-task-story`);
			for (const tab of ["Definition", "Changes"]) {
				if (await clickText(tab, "[role=tab],button")) {
					await Bun.sleep(500);
					await shot(size, `${project}-task-${tab.toLowerCase()}`);
				}
			}
			// docked inspector over the board
			const m = /\/tasks\/([^/?#]+)/.exec(path);
			if (m) {
				await goto(`${p}/board?node=${encodeURIComponent(`task:${m[1]}`)}`);
				await shot(size, `${project}-board-dock`);
			}
		}
		if (want("repo")) {
			// The repository view: every section, then the first branch, worktree
			// and commit it links to (so the detail pages are captured too).
			const firstHref = (re: string) =>
				evalJs<string | null>(`(() => {
					const re = new RegExp(${JSON.stringify(re)});
					const a = [...document.querySelectorAll('a[href]')].find(a => re.test(a.getAttribute('href')||''));
					return a ? a.getAttribute('href') : null; })()`);
			const strip = (h: string | null) => h?.replace(/^\/mfw/, "") ?? null;
			await goto(`${p}/repo`);
			await shot(size, `${project}-repo-files`);
			await goto(`${p}/repo/branches`);
			await Bun.sleep(600);
			await shot(size, `${project}-repo-branches`);
			const branch = strip(await firstHref("/repo/branches/mfw/"));
			if (branch) {
				await goto(branch);
				await Bun.sleep(800);
				await shot(size, `${project}-repo-branch`, { full: true });
			}
			await goto(`${p}/repo/worktrees`);
			await Bun.sleep(600);
			await shot(size, `${project}-repo-worktrees`);
			const wt = strip(await firstHref("/repo/worktree/(?!root)"));
			if (wt) {
				await goto(wt);
				await Bun.sleep(800);
				await shot(size, `${project}-repo-worktree`);
			}
			await goto(`${p}/repo/commits`);
			await Bun.sleep(600);
			await shot(size, `${project}-repo-commits`);
			const commit = strip(await firstHref("/repo/commit/"));
			if (commit) {
				await goto(commit);
				await Bun.sleep(800);
				await shot(size, `${project}-repo-commit`);
			}
			await goto(`${p}/repo/compare`);
			await shot(size, `${project}-repo-compare`);
		}
		if (want("docs")) {
			await goto(`${p}/docs`);
			await Bun.sleep(600);
			await shot(size, `${project}-docs`);
			const first = await evalJs<string | null>(`(() => {
				const a = [...document.querySelectorAll('a[href]')].find(a => /\\/docs\\/[^/?#]+\\/[^?#]+/.test(a.getAttribute('href')||''));
				return a ? a.getAttribute('href') : null; })()`);
			const targets = DOCS.length
				? DOCS.map((d) => `${p}/docs/${d}`)
				: first
					? [first.replace(/^\/mfw/, "")]
					: [];
			for (const [i, target] of targets.entries()) {
				await goto(target);
				// Mermaid is a lazy chunk: give diagrams time to draw.
				await Bun.sleep(2500);
				await shot(size, `${project}-docs-doc${i + 1}`, { full: true });
			}
		}
		if (want("settings")) {
			await goto(`${p}/settings`);
			// Settings is long (Dispatch, Agent, Board, Brain, Budgets...): whole document.
			await shot(size, `${project}-settings`, { full: true });
		}
	}
}

writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nscreenshots + report.json in ${OUT}`);
let bad = 0;
for (const [k, v] of Object.entries(report)) {
	if (!v.issues.length) continue;
	bad++;
	console.log(`\n${k}`);
	for (const i of v.issues) console.log(`  - ${i}`);
}
if (!bad) console.log("no console errors or failed requests");
bidi.close();
cleanup();
process.exit(0);
