import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { saveConfig } from "./config.ts";
import { runProc } from "./proc.ts";

const BASE_PATH = "/mfw";
const MAX_LOG_BYTES = 128 * 1024;

function requireGate(): void {
	if (!process.argv.includes("--runpod-disabled")) {
		throw new Error("deployment smoke requires --runpod-disabled");
	}
	if (process.env.RUNPOD_API_KEY) {
		throw new Error("deployment smoke refuses an ambient RUNPOD_API_KEY");
	}
}

async function freePort(): Promise<number> {
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = reservation.port;
	await reservation.stop(true);
	if (port === undefined)
		throw new Error("could not allocate an ephemeral port");
	return port;
}

async function initProject(root: string, name: string): Promise<string> {
	const project = join(root, name);
	await mkdir(project, { recursive: true });
	const env = {
		CI: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: join(root, "operator-home"),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
	};
	const git = async (args: string[]) => {
		const result = await runProc(["git", "-C", project, ...args], {
			env,
			timeoutMs: 15_000,
			maxOutputBytes: 32 * 1024,
		});
		if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
	};
	await git(["init", "-b", "main"]);
	await mkdir(join(project, ".mfw"), { recursive: true });
	await writeFileAtomic(join(project, "README.md"), `# ${name}\n`);
	await writeFileAtomic(
		join(project, ".mfw", "AGENTS.md"),
		"Disposable deployment-smoke project.\n",
	);
	await git(["add", "README.md", ".mfw/AGENTS.md"]);
	await git([
		"-c",
		"user.name=mfw deployment smoke",
		"-c",
		"user.email=mfw-smoke@invalid.local",
		"commit",
		"-m",
		"initial",
	]);
	return project;
}

function appendTail(current: string, chunk: Uint8Array): string {
	const next = current + new TextDecoder().decode(chunk);
	return next.length <= MAX_LOG_BYTES ? next : next.slice(-MAX_LOG_BYTES);
}

async function capture(
	stream: ReadableStream<Uint8Array> | null,
	state: { value: string },
): Promise<void> {
	if (!stream) return;
	for await (const chunk of stream)
		state.value = appendTail(state.value, chunk);
}

async function startServer(input: {
	repoRoot: string;
	home: string;
	operatorHome: string;
	port: number;
}) {
	const logs = { value: "" };
	const child = Bun.spawn(
		[process.execPath, "run", "apps/start/.output/server/index.mjs"],
		{
			cwd: input.repoRoot,
			env: {
				CI: "1",
				HOME: input.operatorHome,
				HOST: "127.0.0.1",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				MFW_HOME: input.home,
				NO_COLOR: "1",
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				PORT: String(input.port),
				TERM: "dumb",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = Promise.all([
		capture(child.stdout, logs),
		capture(child.stderr, logs),
	]);
	return {
		child,
		logs,
		async stop() {
			child.kill();
			const exited = await Promise.race([
				child.exited,
				Bun.sleep(15_000).then(() => null),
			]);
			if (exited === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
			await output;
		},
	};
}

async function waitForRoute(
	url: string,
	logs: { value: string },
): Promise<string> {
	for (let attempt = 0; attempt < 120; attempt++) {
		const response = await fetch(url).catch(() => null);
		if (response?.ok) return response.text();
		await Bun.sleep(250);
	}
	throw new Error(
		`server did not become ready; bounded log tail:\n${logs.value}`,
	);
}

async function trpcQuery<T>(origin: string, procedure: string): Promise<T> {
	const response = await fetch(`${origin}/api/trpc/${procedure}`);
	if (!response.ok)
		throw new Error(`global API ${procedure} returned ${response.status}`);
	const body = (await response.json()) as {
		result?: { data?: { json?: T } };
		error?: unknown;
	};
	if (body.error || body.result?.data?.json === undefined) {
		throw new Error(`global API ${procedure} returned an invalid response`);
	}
	return body.result.data.json;
}

async function assertRouteAssets(
	origin: string,
	route: string,
	html: string,
): Promise<void> {
	const paths = [
		...html.matchAll(/(?:href|src)="([^"]*\/assets\/[^"]+)"/g),
	].map((match) => match[1] as string);
	if (paths.length === 0)
		throw new Error(`${route} did not reference any built assets`);
	for (const path of new Set(paths)) {
		const url = path.startsWith("http")
			? path
			: `${new URL(origin).origin}${path.startsWith("/") ? path : `/${path}`}`;
		const response = await fetch(url);
		if (!response.ok)
			throw new Error(`${route} asset ${path} returned ${response.status}`);
		const contentType = response.headers.get("content-type") ?? "";
		if (path.endsWith(".css") && !contentType.startsWith("text/css")) {
			throw new Error(
				`${route} stylesheet ${path} returned ${contentType || "no content type"}`,
			);
		}
		if (path.endsWith(".js") && !/(?:java|ecma)script/.test(contentType)) {
			throw new Error(
				`${route} script ${path} returned ${contentType || "no content type"}`,
			);
		}
	}
}

async function inspectServer(port: number, logs: { value: string }) {
	const origin = `http://127.0.0.1:${port}${BASE_PATH}`;
	const routes = ["resources", "runpod", "p/smoke-1/settings"] as const;
	const htmlByRoute = await Promise.all(
		routes.map(
			async (route) =>
				[route, await waitForRoute(`${origin}/${route}`, logs)] as const,
		),
	);
	for (const [route, html] of htmlByRoute) {
		if (!html.includes(`${BASE_PATH}/assets/`)) {
			throw new Error(
				`${route} deep link did not retain the configured base path`,
			);
		}
		await assertRouteAssets(origin, route, html);
	}
	const [projects, host, runpod] = await Promise.all([
		trpcQuery<Array<{ name: string }>>(origin, "system.projects"),
		trpcQuery<{ hostId: string }>(origin, "hostResources.read"),
		trpcQuery<{
			enabled: boolean;
			accountId: string;
			credential: { ready: boolean };
			pods: unknown[];
			settings: { version: number };
		}>(origin, "runpod.get"),
	]);
	if (projects.length !== 2)
		throw new Error("both disposable projects did not attach");
	if (runpod.enabled || runpod.credential.ready || runpod.pods.length !== 0) {
		throw new Error(
			"disabled RunPod smoke unexpectedly exposed provider state",
		);
	}
	return {
		hostId: host.hostId,
		accountId: runpod.accountId,
		settingsVersion: runpod.settings.version,
	};
}

async function assertCleanProject(project: string): Promise<void> {
	let last = "git status did not run";
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await runProc(
			["git", "-C", project, "status", "--porcelain"],
			{
				env: {
					CI: "1",
					GIT_TERMINAL_PROMPT: "0",
					HOME: dirname(project),
					LANG: "C.UTF-8",
					LC_ALL: "C.UTF-8",
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				},
				timeoutMs: 15_000,
				maxOutputBytes: 32 * 1024,
			},
		);
		last = result.stdout.trim() || "git status failed";
		if (result.exitCode === 0 && !result.stdout.trim()) return;
		await Bun.sleep(250);
	}
	throw new Error(`deployment smoke left an attached checkout dirty: ${last}`);
}

async function main(): Promise<void> {
	requireGate();
	const repoRoot = resolve(import.meta.dir, "../../..");
	await access(join(repoRoot, "apps/start/.output/server/index.mjs"));
	const root = await mkdtemp(join(tmpdir(), "mfw-deployment-smoke-"));
	const home = join(root, "mfw-home");
	const operatorHome = join(root, "operator-home");
	await mkdir(operatorHome, { recursive: true, mode: 0o700 });
	let server: Awaited<ReturnType<typeof startServer>> | null = null;
	try {
		const projects = await Promise.all([
			initProject(root, "project-a"),
			initProject(root, "project-b"),
		]);
		await saveConfig(
			{
				projects: projects.map((project, index) => ({
					name: `smoke-${index + 1}`,
					root: project,
					integrationBranch: "main",
					schedulerAutostart: false,
				})),
				dispatchPaused: true,
				runpod: { enabled: false },
			},
			home,
		);
		const port = await freePort();
		server = await startServer({ repoRoot, home, operatorHome, port });
		const before = await inspectServer(port, server.logs);
		await Promise.all(projects.map(assertCleanProject));
		await server.stop();
		server = await startServer({ repoRoot, home, operatorHome, port });
		const after = await inspectServer(port, server.logs);
		if (
			before.hostId !== after.hostId ||
			before.accountId !== after.accountId ||
			before.settingsVersion !== after.settingsVersion
		) {
			throw new Error("machine control-plane identity changed across restart");
		}
		await Promise.all(projects.map(assertCleanProject));
		console.log(
			JSON.stringify({
				result: "ok",
				projects: projects.length,
				routes: [
					`${BASE_PATH}/resources`,
					`${BASE_PATH}/runpod`,
					`${BASE_PATH}/p/smoke-1/settings`,
				],
				assetsVerified: true,
				globalApis: ["hostResources.read", "runpod.get"],
				restartIdentityPreserved: true,
				runpodDisabled: true,
			}),
		);
	} finally {
		await server?.stop().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
}

await main();
