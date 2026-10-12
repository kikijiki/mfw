/**
 * A small headless-Firefox driver over WebDriver BiDi (no dependency to
 * install; Firefox >= 130). Same protocol as `tools/ui-capture.ts`, shaped for
 * deterministic screenshots: a frozen page clock, per-navigation preload
 * scripts (theme, storage), network-and-DOM settling, and an issue log.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

	static async connect(url: string, tries = 120): Promise<Bidi> {
		for (let i = 0; i < tries; i++) {
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
		try {
			this.ws.close();
		} catch {
			// already closed
		}
	}
}

/** URLs that are long-lived streams, so "network idle" must not wait for them. */
const STREAMING =
	/(live\.events|usage\.changes|runOutput|\.changes\b|text\/event-stream)/;
/** Dev-server plumbing that is not the app's own traffic. */
const PLUMBING =
	/\/(@vite|@react-refresh|__vite|node_modules\/\.vite|@id|@fs)\b|\.(?:woff2?|map)(\?|$)|favicon/;

export interface Issue {
	kind: "console" | "http" | "fetch" | "exception" | "prompt";
	text: string;
}

export interface BrowserOptions {
	binary: string;
	/** Environment for the browser process (TZ and locale are fixed by the caller). */
	env?: Record<string, string>;
}

export class Browser {
	private proc: ChildProcess | null = null;
	private bidi!: Bidi;
	private ctx = "";
	private profile = "";
	private inflight = new Set<string>();
	private lastNetworkAt = Date.now();
	issues: Issue[] = [];
	private documentStatus = new Map<string, number>();
	private sawProbe = false;
	private preloadId: string | null = null;
	/** Known, benign console warnings that were not reported as issues. */
	knownWarnings = 0;

	async launch(opts: BrowserOptions): Promise<void> {
		this.profile = mkdtempSync(join(tmpdir(), "mfw-screenshots-ff-"));
		// Remote debugging, no first-run noise, no telemetry, no update checks.
		writeFileSync(
			join(this.profile, "user.js"),
			[
				'user_pref("app.update.enabled", false);',
				'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
				'user_pref("browser.shell.checkDefaultBrowser", false);',
				'user_pref("toolkit.telemetry.enabled", false);',
				'user_pref("browser.startup.homepage_override.mstone", "ignore");',
				'user_pref("general.smoothScroll", false);',
				'user_pref("ui.prefersReducedMotion", 1);',
				"",
			].join("\n"),
		);
		const port = 9400 + Math.floor(Math.random() * 400);
		this.proc = spawn(
			opts.binary,
			[
				"--headless",
				"--no-remote",
				"--remote-debugging-port",
				String(port),
				"--profile",
				this.profile,
				"about:blank",
			],
			{
				stdio: "ignore",
				detached: true,
				env: { ...process.env, ...opts.env, MOZ_ENABLE_WAYLAND: "0" },
			},
		);
		this.proc.on("error", () => {});
		this.bidi = await Bidi.connect(`ws://127.0.0.1:${port}/session`);
		await this.bidi.send("session.new", { capabilities: {} });
		await this.bidi.send("session.subscribe", {
			events: [
				"log.entryAdded",
				"network.beforeRequestSent",
				"network.responseCompleted",
				"network.fetchError",
				"browsingContext.userPromptOpened",
			],
		});
		const tree = (await this.bidi.send("browsingContext.getTree")) as {
			contexts: Array<{ context: string }>;
		};
		this.ctx = (tree.contexts[0] as { context: string }).context;
		this.bidi.on((m, p) => this.onEvent(m, p));
		await this.probeConsole();
	}

	private onEvent(method: string, p: Json): void {
		const now = Date.now();
		if (method === "browsingContext.userPromptOpened") {
			this.issues.push({
				kind: "prompt",
				text: `${String(p.type)} ${String(p.message ?? "")}`,
			});
			void this.bidi.send("browsingContext.handleUserPrompt", {
				context: this.ctx,
				accept: true,
			});
		} else if (method === "log.entryAdded") {
			const text = String(p.text ?? "");
			if (text.includes("screenshots-probe")) {
				this.sawProbe = true;
				return;
			}
			const level = p.level as string;
			if (
				/tree hydrated but some attributes of the server rendered HTML/.test(
					text,
				)
			) {
				// A stored theme is applied before hydration, so <html> differs from the SSR
				// markup for any visitor with a saved preference. Counted, not a failure.
				this.knownWarnings++;
				return;
			}
			if (level === "error") {
				this.issues.push({
					kind: p.type === "javascript" ? "exception" : "console",
					text: text.slice(0, 400),
				});
			} else if (
				level === "warning" &&
				!/Download the React DevTools|Sec-Fetch|Layout was forced/i.test(text)
			) {
				this.issues.push({
					kind: "console",
					text: `warning: ${text.slice(0, 400)}`,
				});
			}
		} else if (method === "network.beforeRequestSent") {
			const req = p.request as { request: string; url: string };
			if (!STREAMING.test(req.url) && !PLUMBING.test(req.url)) {
				this.inflight.add(req.request);
				this.lastNetworkAt = now;
			}
		} else if (method === "network.responseCompleted") {
			const req = p.request as { request: string; url: string };
			const res = p.response as { status: number; mimeType?: string };
			this.inflight.delete(req.request);
			this.lastNetworkAt = now;
			if (res.mimeType?.includes("html"))
				this.documentStatus.set(req.url, res.status);
			if (res.status >= 400 && !PLUMBING.test(req.url)) {
				this.issues.push({
					kind: "http",
					text: `HTTP ${res.status}: ${req.url}`,
				});
			}
		} else if (method === "network.fetchError") {
			const req = p.request as { request: string; url: string };
			this.inflight.delete(req.request);
			this.lastNetworkAt = now;
			// Aborted streams are navigation tearing down live subscriptions.
			if (!/ABORT/i.test(String(p.errorText)) && !PLUMBING.test(req.url))
				this.issues.push({
					kind: "fetch",
					text: `${String(p.errorText)} ${req.url}`,
				});
		}
	}

	/** Prove console capture works, so "no errors" means something. */
	private async probeConsole(): Promise<void> {
		await this.eval(`(console.error("screenshots-probe"), 1)`);
		await Bun.sleep(300);
		if (!this.sawProbe)
			console.warn(
				"WARNING: console events are not reaching the capture; 'no errors' is not trustworthy",
			);
		this.issues = [];
	}

	async eval<T = unknown>(expression: string): Promise<T> {
		const r = (await this.bidi.send("script.evaluate", {
			expression: `(async()=>{ const v = await (${expression}); return JSON.stringify(v ?? null); })()`,
			target: { context: this.ctx },
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

	async setViewport(w: number, h: number, dpr: number): Promise<void> {
		await this.bidi.send("browsingContext.setViewport", {
			context: this.ctx,
			viewport: { width: w, height: h },
			devicePixelRatio: dpr,
		});
	}

	/** Replace the preload script run before every page script on each navigation. */
	async setPreload(source: string): Promise<void> {
		if (this.preloadId) {
			await this.bidi
				.send("script.removePreloadScript", { script: this.preloadId })
				.catch(() => {});
			this.preloadId = null;
		}
		const r = (await this.bidi.send("script.addPreloadScript", {
			functionDeclaration: `() => { ${source} }`,
		})) as { script: string };
		this.preloadId = r.script;
	}

	/** Navigate and return the document's HTTP status (0 when unknown). */
	async goto(url: string, timeoutMs = 60_000): Promise<number> {
		this.documentStatus.delete(url);
		let timedOut = false;
		await Promise.race([
			this.bidi.send("browsingContext.navigate", {
				context: this.ctx,
				url,
				wait: "complete",
			}),
			Bun.sleep(timeoutMs).then(() => {
				timedOut = true;
			}),
		]);
		if (timedOut)
			this.issues.push({
				kind: "fetch",
				text: `navigation to ${url} timed out`,
			});
		return this.documentStatus.get(url) ?? 0;
	}

	/**
	 * Settled = nothing in flight for `quietMs`, the DOM stopped changing for
	 * `quietMs`, and no skeleton or busy marker left.
	 */
	async settle(quietMs = 900, maxMs = 30_000): Promise<void> {
		const t0 = Date.now();
		let lastCount = -1;
		let lastChange = Date.now();
		while (Date.now() - t0 < maxMs) {
			const state = await this.eval<{ n: number; busy: boolean }>(`(() => ({
				n: document.querySelectorAll('*').length + document.body.innerText.length,
				busy: !!document.querySelector('[aria-busy="true"], .mfw-skeleton'),
			}))()`).catch(() => ({ n: -1, busy: true }));
			if (state.n !== lastCount) {
				lastCount = state.n;
				lastChange = Date.now();
			}
			const now = Date.now();
			const netQuiet =
				this.inflight.size === 0 && now - this.lastNetworkAt > quietMs;
			if (netQuiet && !state.busy && now - lastChange > quietMs) return;
			await Bun.sleep(150);
		}
	}

	async waitFor(selector: string, timeoutMs = 20_000): Promise<boolean> {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			if (
				await this.eval<boolean>(
					`!!document.querySelector(${JSON.stringify(selector)})`,
				)
			)
				return true;
			await Bun.sleep(150);
		}
		return false;
	}

	async key(chord: string[]): Promise<void> {
		const code: Record<string, string> = {
			Control: "",
			Meta: "",
			Escape: "",
			Enter: "",
			Tab: "",
		};
		const v = (k: string) => code[k] ?? k;
		const down = chord.map((k) => ({ type: "keyDown", value: v(k) }));
		const up = [...chord]
			.reverse()
			.map((k) => ({ type: "keyUp", value: v(k) }));
		await this.bidi.send("input.performActions", {
			context: this.ctx,
			actions: [{ type: "key", id: "kb", actions: [...down, ...up] }],
		});
	}

	/**
	 * Move the pointer over the first visible element matching `selector` (its
	 * centre), then wait `waitMs` so a hover tooltip has opened. False when
	 * nothing matches.
	 */
	async hover(selector: string, waitMs = 900): Promise<boolean> {
		const at = await this.eval<{ x: number; y: number } | null>(`(() => {
			const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => {
				const r = e.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			});
			if (!el) return null;
			el.scrollIntoView({ block: "center" });
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		})()`);
		if (!at) return false;
		await this.bidi.send("input.performActions", {
			context: this.ctx,
			actions: [
				{
					type: "pointer",
					id: "mouse",
					parameters: { pointerType: "mouse" },
					actions: [
						{ type: "pointerMove", x: at.x - 4, y: at.y, duration: 0 },
						{ type: "pointerMove", x: at.x, y: at.y, duration: 50 },
					],
				},
			],
		});
		await Bun.sleep(waitMs);
		return true;
	}

	/** Click the first visible element in `selector` whose text or aria-label contains `text`. */
	async clickText(
		text: string,
		selector = "button,a,[role=tab],[role=button],[role=menuitem]",
	): Promise<boolean> {
		return this.eval<boolean>(`(() => {
			const want = ${JSON.stringify(text.toLowerCase())};
			const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
				const r = e.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			});
			const el = els.find((e) => (e.textContent || '').trim().toLowerCase().includes(want)
				|| (e.getAttribute('aria-label') || '').toLowerCase().includes(want)
				|| (e.getAttribute('title') || '').toLowerCase().includes(want));
			if (!el) return false;
			el.click();
			return true;
		})()`);
	}

	async screenshot(file: string): Promise<void> {
		const r = (await this.bidi.send("browsingContext.captureScreenshot", {
			context: this.ctx,
			origin: "viewport",
		})) as { data: string };
		writeFileSync(file, Buffer.from(r.data, "base64"));
	}

	/** Take (and clear) the issues collected since the last call. */
	takeIssues(): Issue[] {
		const seen = new Set<string>();
		const out: Issue[] = [];
		for (const i of this.issues) {
			const k = `${i.kind}:${i.text}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(i);
		}
		this.issues = [];
		return out;
	}

	async close(): Promise<void> {
		this.bidi?.close();
		const pid = this.proc?.pid;
		if (pid) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// gone
				}
			}
			await Bun.sleep(300);
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// gone
			}
		}
		if (this.profile) rmSync(this.profile, { recursive: true, force: true });
	}
}

/** The page-side clock freeze: `Date` answers `fixedMs` until the page unloads. */
export function freezeClockScript(fixedMs: number): string {
	return `
	const FIXED = ${fixedMs};
	const RealDate = Date;
	function MockDate(...args) {
		if (!new.target) return new RealDate(FIXED).toString();
		return args.length === 0 ? new RealDate(FIXED) : new RealDate(...args);
	}
	MockDate.prototype = RealDate.prototype;
	MockDate.now = () => FIXED;
	MockDate.parse = RealDate.parse;
	MockDate.UTC = RealDate.UTC;
	window.Date = MockDate;`;
}

/** localStorage entries and quiet CSS applied before the app boots. */
export function storageScript(entries: Record<string, string>): string {
	return `
	try {
		const entries = ${JSON.stringify(entries)};
		for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
	} catch {}
	document.addEventListener('DOMContentLoaded', () => {
		const style = document.createElement('style');
		style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important}*{scrollbar-width:none!important}';
		document.head.appendChild(style);
	});`;
}
