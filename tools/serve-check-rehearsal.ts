#!/usr/bin/env bun
/**
 * Proves `tools/tailscale-serve-check.sh` can tell a good proxy from a bad one
 * (review F6), without Tailscale.
 *
 *   bun run build && bun run smoke:serve-check
 *
 * A local TLS proxy targets the script's unix socket the way Serve does. Run
 * once replacing the forwarded headers, the script must pass. Run again letting
 * a client's `X-Forwarded-Host` or `-Proto` through, it must fail and name the
 * header. `MFW_SERVE_CHECK_SCRIPT` runs another copy of the script.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT =
	process.env.MFW_SERVE_CHECK_SCRIPT ??
	join(ROOT, "tools/tailscale-serve-check.sh");

type Mode = "replaces" | "passes-host" | "passes-proto";

async function rehearse(
	mode: Mode,
	tls: { key: string; cert: string },
	scratch: string,
): Promise<{ exit: number; lines: string[] }> {
	let socket = "";
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const h = new Headers(req.headers);
			const external = req.headers.get("host") as string;
			h.set("host", "localhost");
			h.set("x-forwarded-for", srv.requestIP(req)?.address ?? "");
			if (mode !== "passes-host" || !h.has("x-forwarded-host"))
				h.set("x-forwarded-host", external);
			if (mode !== "passes-proto" || !h.has("x-forwarded-proto"))
				h.set("x-forwarded-proto", "https");
			h.delete("accept-encoding");
			return fetch(`http://localhost${url.pathname}${url.search}`, {
				unix: socket,
				method: req.method,
				headers: h,
				body: req.body,
				redirect: "manual",
			} as RequestInit);
		},
	});
	const external = `box.example.test:${proxy.port}`;
	try {
		const p = Bun.spawn(["bash", SCRIPT, external], {
			cwd: ROOT,
			env: {
				...process.env,
				TMPDIR: scratch,
				MFW_CHECK_PORT: String(47800 + Math.floor(Math.random() * 150)),
				MFW_CHECK_CURL_OPTS: `-k --resolve ${external}:127.0.0.1`,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const errors = new Response(p.stderr).text();
		const reader = p.stdout.getReader();
		const decoder = new TextDecoder();
		let out = "";
		let answered = false;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value);
			const target = /unix:(\S+)/.exec(out)?.[1];
			if (target && !answered) {
				answered = true;
				socket = target;
				p.stdin.write("\n");
				await p.stdin.flush();
				await p.stdin.end();
			}
		}
		const exit = await p.exited;
		const stderr = (await errors).trim();
		if (!answered) throw new Error(`script never published: ${stderr}`);
		return {
			exit,
			lines: out.split("\n").filter((l) => /^(ok|FAIL)/.test(l)),
		};
	} finally {
		proxy.stop(true);
	}
}

async function main(): Promise<number> {
	const openssl = Bun.which("openssl");
	if (!openssl) throw new Error("openssl is required on PATH");
	const scratch = mkdtempSync(join(tmpdir(), "mfw-test-serve-check-"));
	try {
		const keyFile = join(scratch, "k.pem");
		const certFile = join(scratch, "c.pem");
		const made = Bun.spawnSync(
			[openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"]
				.concat(["-subj", "/CN=box.example.test"])
				.concat(["-keyout", keyFile, "-out", certFile]),
			{ stdout: "ignore", stderr: "ignore" },
		);
		if (made.exitCode !== 0) throw new Error("openssl could not make a cert");
		const tls = {
			key: readFileSync(keyFile, "utf8"),
			cert: readFileSync(certFile, "utf8"),
		};
		const failures: string[] = [];
		const good = await rehearse("replaces", tls, scratch);
		if (good.exit !== 0)
			failures.push(`good proxy failed: ${good.lines.join(" | ")}`);
		for (const [mode, name] of [
			["passes-host", "X-Forwarded-Host"],
			["passes-proto", "X-Forwarded-Proto"],
		] as const) {
			const bad = await rehearse(mode, tls, scratch);
			if (
				bad.exit === 0 ||
				!bad.lines.some((l) => l.startsWith("FAIL") && l.includes(name))
			)
				failures.push(`a proxy passing a client's ${name} was not detected`);
		}
		console.log(`serve-check: ${failures.length ? "failed" : "passed"}`);
		for (const f of failures) console.log(`  FAIL ${f}`);
		return failures.length ? 1 : 0;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exit(await main());
