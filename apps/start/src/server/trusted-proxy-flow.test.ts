import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthService,
	FREE_ATTEMPTS,
	PROXIED_FREE_FAILURES,
} from "@mfw/daemon/auth/service";
import { enforceExposure } from "./auth-boot";
import { guardRequest, isTls, sessionCookie } from "./auth-guard";
import { AUTH_INTENT_HEADER, handleAuthAction } from "./auth-routes";
import { checkExposure, exposureWarnings, parseAllowedHosts } from "./exposure";
import { checkRequest, requestContext } from "./request-guard";
import { UNIX_PEER } from "./trusted-proxy";

const PASSWORD = "correct horse battery";
/** Well above two argon2 checks, so timing shows the pacing and not the hash. */
const PACE_MS = 1200;
const EXTERNAL = "box.tail1234.ts.net:8443";
const ENV = {
	MFW_TRUSTED_PROXIES: "127.0.0.1",
	MFW_ALLOWED_HOSTS: EXTERNAL,
};

function request(
	peer: string | undefined,
	headers: Record<string, string>,
	init: RequestInit = {},
	path = "/mfw/api/auth/state",
): Request {
	const req = new Request(`http://127.0.0.1:7777${path}`, {
		...init,
		headers: { host: "127.0.0.1:7777", ...headers },
	});
	if (peer) Object.defineProperty(req, "ip", { value: peer });
	return req;
}

const viaProxy = (client: string, extra: Record<string, string> = {}) => ({
	host: EXTERNAL,
	"x-forwarded-for": client,
	"x-forwarded-proto": "https",
	"x-forwarded-host": EXTERNAL,
	...extra,
});

describe("forwarded headers are spoofing-proof", () => {
	test("with no trusted proxy, a loopback peer cannot claim TLS", () => {
		const r = request("127.0.0.1", {
			host: "localhost:7777",
			"x-forwarded-proto": "https",
		});
		expect(requestContext(r, {}).proxied).toBe(false);
		expect(requestContext(r, {}).scheme).toBe("http:");
		expect(isTls(r)).toBe(false);
	});

	test("an untrusted peer cannot claim a listed host", () => {
		const r = request("198.51.100.7", viaProxy("203.0.113.9"));
		expect(checkRequest(r, ENV)?.status).toBe(403);
	});

	test("an untrusted peer's forged address is not its identity", () => {
		const r = request("198.51.100.7", viaProxy("203.0.113.9"));
		expect(requestContext(r, ENV).client).toBe("198.51.100.7");
	});

	test("malformed headers from the proxy are refused, not ignored", () => {
		const r = request("127.0.0.1", viaProxy("not-an-address"));
		expect(checkRequest(r, ENV)?.status).toBe(403);
	});
});

describe("host and origin behind the proxy", () => {
	const check = (h: Record<string, string>, env = ENV) =>
		checkRequest(request("127.0.0.1", h), env);

	test("the listed external origin passes", () => {
		expect(
			check(viaProxy("203.0.113.9", { origin: `https://${EXTERNAL}` })),
		).toBeNull();
	});
	test("an http Origin is refused", () => {
		expect(
			check(viaProxy("203.0.113.9", { origin: `http://${EXTERNAL}` }))?.status,
		).toBe(403);
	});
	test("a sibling HTTPS port on the same name is refused", () => {
		const sibling = "box.tail1234.ts.net:9443";
		expect(
			check(viaProxy("203.0.113.9", { origin: `https://${sibling}` }))?.status,
		).toBe(403);
		expect(
			check(viaProxy("203.0.113.9", { "x-forwarded-host": sibling }))?.status,
		).toBe(403);
	});
	test("a bare entry means the default HTTPS port only", () => {
		const env = { ...ENV, MFW_ALLOWED_HOSTS: "box.ts.net" };
		const at = (host: string) =>
			check(viaProxy("203.0.113.9", { "x-forwarded-host": host }), env);
		expect(at("box.ts.net")).toBeNull();
		expect(at("box.ts.net:443")).toBeNull();
		expect(at("box.ts.net:8443")?.status).toBe(403);
	});
	test("a forwarded loopback or unlisted host is refused", () => {
		for (const host of ["localhost", "127.0.0.1:7777", "evil.example"])
			expect(
				check(viaProxy("203.0.113.9", { "x-forwarded-host": host }))?.status,
			).toBe(403);
	});
	test("names are exact: no suffix or subdomain matches", () => {
		for (const host of [
			`evil.${EXTERNAL}`,
			"tail1234.ts.net:8443",
			`${EXTERNAL}.evil.example`,
		])
			expect(
				check(viaProxy("203.0.113.9", { "x-forwarded-host": host }))?.status,
			).toBe(403);
	});
	test("without X-Forwarded-Host the Host header is the external host", () => {
		const h = viaProxy("203.0.113.9");
		delete (h as Record<string, string>)["x-forwarded-host"];
		expect(check(h)).toBeNull();
	});
	test("the local browser keeps working through a trusted loopback peer", () => {
		expect(
			check({ host: "localhost:7777", origin: "http://localhost:7777" }),
		).toBeNull();
	});
});

describe("direct access beyond loopback", () => {
	test("a remote peer is refused even when it sends Host: localhost", () => {
		const r = request("100.64.0.9", { host: "localhost:7777" });
		expect(checkRequest(r, { HOST: "100.64.0.1" })?.status).toBe(403);
	});
	test("a listed host on plain HTTP is refused", () => {
		const r = request("127.0.0.1", { host: EXTERNAL });
		expect(checkRequest(r, { MFW_ALLOWED_HOSTS: EXTERNAL })?.status).toBe(403);
	});
	test("an unknown peer on an exposed listener is refused", () => {
		const r = request(undefined, { host: "localhost:7777" });
		expect(checkRequest(r, { HOST: "100.64.0.1" })?.status).toBe(403);
	});
	test("a remote peer cannot use a loopback name over native TLS", () => {
		const env = {
			HOST: "100.64.0.1",
			NITRO_SSL_CERT: "c",
			NITRO_SSL_KEY: "k",
		};
		const r = request("100.64.0.9", { host: "localhost:7777" });
		expect(checkRequest(r, env)?.status).toBe(403);
	});
});

describe("cookies behind the TLS proxy", () => {
	test("__Secure- name, Secure, HttpOnly, Strict, base Path", () => {
		const r = request("127.0.0.1", viaProxy("203.0.113.9"));
		expect(checkRequest(r, ENV)).toBeNull();
		const c = sessionCookie(r, "token", "/mfw/");
		expect(c).toStartWith("__Secure-mfw_session=token;");
		expect(c).toContain("; Secure");
		expect(c).toContain("HttpOnly");
		expect(c).toContain("SameSite=Strict");
		expect(c).toContain("Path=/mfw;");
	});
	test("the same headers from an untrusted peer stay plain", () => {
		const r = request("198.51.100.7", viaProxy("203.0.113.9"));
		requestContext(r, ENV);
		const c = sessionCookie(r, "token", "/mfw/");
		expect(c).toStartWith("mfw_session=token;");
		expect(c).not.toContain("Secure");
	});
});

describe("throttle behind a trusted proxy", () => {
	let dir: string;
	let auth: AuthService;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "mfw-proxy-"));
		auth = await AuthService.open(join(dir, "auth.db"), {
			passwordCheckIntervalMs: 1,
			proxiedCheckIntervalMs: PACE_MS,
		});
		await auth.setup((await auth.beginFirstRun()) as string, PASSWORD);
	});
	afterEach(() => {
		auth.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function login(
		peer: string,
		headers: Record<string, string>,
		password: string,
		env: Record<string, string | undefined> = ENV,
	): Promise<Response> {
		const req = request(
			peer,
			{
				"content-type": "application/json",
				[AUTH_INTENT_HEADER]: "1",
				...headers,
			},
			{ method: "POST", body: JSON.stringify({ password }) },
			"/mfw/api/auth/login",
		);
		const guarded = await guardRequest(req, { auth, base: "/mfw/", env });
		if (!guarded.ok) return guarded.response;
		return handleAuthAction("login", req, guarded, auth, "/mfw/");
	}

	test("one client's failures do not lock another", async () => {
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await login("127.0.0.1", viaProxy("203.0.113.1"), "wrong password!");
		expect(
			(await login("127.0.0.1", viaProxy("203.0.113.1"), PASSWORD)).status,
		).toBe(429);
		expect(
			(await login("127.0.0.1", viaProxy("203.0.113.2"), PASSWORD)).status,
		).toBe(200);
	});

	test("a forged left entry does not escape the client's bucket", async () => {
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await login(
				"127.0.0.1",
				viaProxy(`10.9.9.${i}, 203.0.113.1`),
				"wrong password!",
			);
		expect(
			(await login("127.0.0.1", viaProxy("203.0.113.1"), PASSWORD)).status,
		).toBe(429);
	});

	test("without a trusted proxy, rotating the header does not rotate the bucket", async () => {
		const env = { MFW_ALLOWED_HOSTS: EXTERNAL };
		const h = (i: number) => ({
			host: "localhost:7777",
			"x-forwarded-for": `203.0.113.${i}`,
		});
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await login("127.0.0.1", h(i), "wrong password!", env);
		expect((await login("127.0.0.1", h(99), PASSWORD, env)).status).toBe(429);
	});

	test("forged rotation is paced once the shared budget is spent, and the owner still gets in", async () => {
		for (let i = 0; i < PROXIED_FREE_FAILURES; i++)
			expect(
				(await login("127.0.0.1", viaProxy(`203.0.113.${i}`), "wrong guess!!"))
					.status,
			).toBe(401);
		const started = performance.now();
		await login("127.0.0.1", viaProxy("198.51.100.1"), "wrong guess!!");
		await login("127.0.0.1", viaProxy("198.51.100.2"), "wrong guess!!");
		expect(performance.now() - started).toBeGreaterThanOrEqual(PACE_MS - 50);
		expect(
			(await login("127.0.0.1", viaProxy("198.51.100.3"), PASSWORD)).status,
		).toBe(200);
	});

	test("mfw auth unlock clears the shared budget", async () => {
		for (let i = 0; i < PROXIED_FREE_FAILURES; i++)
			await login("127.0.0.1", viaProxy(`203.0.113.${i}`), "wrong guess!!");
		await auth.unlock();
		const started = performance.now();
		await login("127.0.0.1", viaProxy("198.51.100.1"), "wrong guess!!");
		await login("127.0.0.1", viaProxy("198.51.100.2"), "wrong guess!!");
		expect(performance.now() - started).toBeLessThan(PACE_MS - 50);
	});

	test("direct attempts do not draw on the proxied budget", async () => {
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await login("127.0.0.1", { host: "localhost:7777" }, "wrong password!");
		const row = await (
			auth as unknown as {
				db: { client: { execute(q: string): Promise<{ rows: unknown[] }> } };
			}
		).db.client.execute(
			"SELECT 1 FROM auth_throttle WHERE scope = 'login:via-proxy'",
		);
		expect(row.rows.length).toBe(0);
	});
});

describe("the private proxy socket (review F2)", () => {
	const unixRequest = (headers: Record<string, string>) => {
		const r = request(undefined, headers);
		Object.defineProperty(r, UNIX_PEER, { value: true });
		return r;
	};
	const env = { MFW_ALLOWED_HOSTS: EXTERNAL };

	test("its peer is the proxy, with no address list", () => {
		const r = unixRequest(viaProxy("203.0.113.9", { host: "localhost" }));
		expect(checkRequest(r, env)).toBeNull();
		expect(requestContext(r, env).client).toBe("203.0.113.9");
		expect(requestContext(r, env).scheme).toBe("https:");
	});
	test("without forwarded headers it refuses", () => {
		expect(checkRequest(unixRequest({ host: "localhost" }), env)?.status).toBe(
			403,
		);
	});
	test("a header cannot claim to be the unix peer", () => {
		const r = request(
			"127.0.0.1",
			viaProxy("203.0.113.9", { "mfw.unixPeer": "true" }),
		);
		expect(requestContext(r, env).proxied).toBe(false);
	});
	for (const [name, MFW_LISTEN_SOCKET] of [
		["relative", "serve/mfw.sock"],
		["outside the home", "/run/user/1000/mfw.sock"],
		["directly in the home", "/h/mfw/mfw.sock"],
		["with dot segments", "/h/mfw/serve/../../x/mfw.sock"],
		["too long", `/h/mfw/serve/${"x".repeat(120)}.sock`],
	] as const)
		test(`a socket path ${name} is refused`, () => {
			expect(
				checkExposure({
					HOST: "127.0.0.1",
					MFW_HOME: "/h/mfw",
					MFW_ALLOWED_HOSTS: EXTERNAL,
					MFW_LISTEN_SOCKET,
				}),
			).toContain("MFW_LISTEN_SOCKET");
		});
	test("a good path needs an exact host", () => {
		const socket = {
			HOST: "127.0.0.1",
			MFW_HOME: "/h/mfw",
			MFW_LISTEN_SOCKET: "/h/mfw/serve/mfw.sock",
		};
		expect(checkExposure(socket)).toContain("MFW_ALLOWED_HOSTS");
		expect(checkExposure({ ...socket, ...env })).toBeNull();
	});
	for (const list of ["127.0.0.1", "127.0.0.0/8", "::1", "10.0.0.1 ::1"])
		test(`trusting ${list} warns`, () => {
			expect(exposureWarnings({ MFW_TRUSTED_PROXIES: list }).join()).toContain(
				"ANY LOCAL PROCESS",
			);
		});
	test("a remote proxy or the socket does not warn", () => {
		expect(exposureWarnings({ MFW_TRUSTED_PROXIES: "10.0.0.1" })).toEqual([]);
		expect(exposureWarnings({})).toEqual([]);
	});
});

describe("exposure at startup", () => {
	const TLS = { NITRO_SSL_CERT: "cert", NITRO_SSL_KEY: "key" };

	for (const HOST of ["127.0.0.1", "127.8.8.8", "::1", "localhost"])
		test(`loopback HOST=${HOST} starts`, () => {
			expect(checkExposure({ HOST })).toBeNull();
		});

	for (const HOST of ["100.64.0.1", "192.168.1.5", "fd00::1"])
		test(`plain HTTP on ${HOST} is refused with the fix`, () => {
			const why = checkExposure({ HOST });
			expect(why).toContain("not loopback");
			expect(why).toContain("MFW_TRUSTED_PROXIES");
		});

	// Review F4: every spelling of the unspecified address.
	for (const HOST of [
		"0.0.0.0",
		"::",
		"0:0:0:0:0:0:0:0",
		"::0",
		"0000::",
		"::ffff:0.0.0.0",
		"::ffff:0:0",
	])
		test(`unspecified ${HOST} is refused even with TLS or a proxy`, () => {
			expect(checkExposure({ HOST, ...TLS })).toContain("every interface");
			expect(checkExposure({ HOST, ...ENV })).toContain("every interface");
		});

	// Anything but `localhost` or a canonical literal can mean something else.
	for (const HOST of [
		"00.0.0.0",
		"0",
		"0.0",
		"0x0",
		"*",
		"[::]",
		"[::1]",
		"::%lo",
		"::1%lo",
		"127.1",
		"127.0.0.01",
		"2130706433",
		"0:0:0:0:0:0:0:1",
		"::0001",
		"::ffff:127.0.0.1",
		"FD00::1",
		"fd00:0::1",
		"LOCALHOST",
		"localhost.",
		"foo.localhost",
		"box.example",
		" 127.0.0.1",
	])
		test(`non-canonical HOST '${HOST}' is refused even with TLS or a proxy`, () => {
			expect(checkExposure({ HOST, ...TLS })).toContain("canonical");
			expect(checkExposure({ HOST, ...ENV })).toContain("canonical");
		});

	test("an unset HOST is refused: Bun would listen everywhere", () => {
		expect(checkExposure({})).toContain("HOST is not set");
		expect(checkExposure({ HOST: "" })).toContain("HOST is not set");
	});
	test("NITRO_HOST wins over HOST, as in the runtime", () => {
		expect(
			checkExposure({ NITRO_HOST: "100.64.0.1", HOST: "127.0.0.1" }),
		).toContain("not loopback");
		expect(
			checkExposure({ NITRO_HOST: "127.0.0.1", HOST: "100.64.0.1" }),
		).toBeNull();
	});
	test("native TLS allows a specific address", () => {
		expect(checkExposure({ HOST: "100.64.0.1", ...TLS })).toBeNull();
	});
	test("half-configured TLS is refused", () => {
		expect(
			checkExposure({ HOST: "100.64.0.1", NITRO_SSL_CERT: "c" }),
		).toContain("half configured");
	});
	test("a proxy needs both a peer and an exact host", () => {
		const HOST = "100.64.0.1";
		expect(checkExposure({ HOST, ...ENV })).toBeNull();
		expect(
			checkExposure({ HOST, MFW_TRUSTED_PROXIES: "100.64.0.2" }),
		).toContain("not loopback");
		expect(checkExposure({ HOST, MFW_ALLOWED_HOSTS: EXTERNAL })).toContain(
			"not loopback",
		);
	});
	test("no environment switch bypasses the refusal", () => {
		for (const name of [
			"MFW_ALLOW_INSECURE",
			"MFW_INSECURE",
			"MFW_DEV",
			"NODE_ENV",
			"DEV",
		])
			expect(
				checkExposure({ HOST: "100.64.0.1", [name]: "development" }),
			).not.toBeNull();
	});
	test("bad proxy or host entries stop the server", () => {
		expect(
			checkExposure({ HOST: "127.0.0.1", MFW_TRUSTED_PROXIES: "0.0.0.0/0" }),
		).toContain("MFW_TRUSTED_PROXIES");
		for (const entry of ["*.ts.net", ".ts.net", "https://box.ts.net", "*"])
			expect(
				checkExposure({ HOST: "127.0.0.1", MFW_ALLOWED_HOSTS: entry }),
			).toContain("MFW_ALLOWED_HOSTS");
	});
	test("a bad allowed entry is never honoured at request time", () => {
		expect(parseAllowedHosts("*.ts.net, .ts.net, ok.example").hosts).toEqual([
			{ host: "ok.example", port: null },
		]);
	});
	test("enforceExposure exits non-zero and prints the fix", () => {
		const lines: string[] = [];
		const codes: number[] = [];
		enforceExposure(
			{ HOST: "100.64.0.1" },
			(c) => codes.push(c),
			(l) => lines.push(l),
		);
		expect(codes).toEqual([1]);
		expect(lines.join("\n")).toContain("refusing to start");
		expect(lines.join("\n")).toContain("HOST=127.0.0.1");
	});
});
