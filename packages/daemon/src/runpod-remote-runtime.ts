/**
 * Bundled and uploaded by RunPodExecutionTarget. This is a small argv-only
 * remote runtime, not a provider-specific image setup script.
 */
import {
	appendFile,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	redactSecretValues,
	SerializedChannelSink,
	StreamingSecretRedactor,
} from "./execution-environment.ts";
import {
	createRemoteCollection,
	materializeRemoteStage,
} from "./remote-worktree.ts";

interface RuntimeConfig {
	runDir: string;
	executionPath: string;
	driverScript: string;
	secretNames: string[];
	driver: Record<string, unknown>;
}

async function copyRedacted(
	stream: ReadableStream<Uint8Array>,
	channel: "stdout" | "stderr",
	sink: SerializedChannelSink,
	secrets: Readonly<Record<string, string>>,
): Promise<void> {
	const reader = stream.getReader();
	const redactor = new StreamingSecretRedactor(secrets);
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		const output = redactor.push(value);
		if (output) await sink.append(channel, output);
	}
	const final = redactor.finish();
	await sink.append(channel, redactSecretValues(final, secrets), true);
}

async function redactEvidenceFile(
	path: string,
	secrets: Readonly<Record<string, string>>,
): Promise<void> {
	const source = await open(path, "r").catch((error) => {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	});
	if (!source) return;
	const temporary = `${path}.redacting`;
	const destination = await open(temporary, "wx", 0o600);
	const redactor = new StreamingSecretRedactor(secrets);
	const buffer = new Uint8Array(64 * 1024);
	try {
		for (;;) {
			const { bytesRead } = await source.read(
				buffer,
				0,
				buffer.byteLength,
				null,
			);
			if (bytesRead === 0) break;
			const output = redactor.push(buffer.subarray(0, bytesRead));
			if (output) await destination.writeFile(output);
		}
		const final = redactor.finish();
		if (final) await destination.writeFile(final);
		await destination.sync();
		await source.close();
		await destination.close();
		await rename(temporary, path);
	} catch (error) {
		await source.close().catch(() => {});
		await destination.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

async function stage(
	stagePath: string,
	executionPath: string,
	gitPath: string,
): Promise<void> {
	const wanted = JSON.parse(await readFile(stagePath, "utf8")) as {
		digest?: string;
	};
	const prior = await readFile(
		join(executionPath, ".git", "mfw", "stage.json"),
		"utf8",
	).catch(() => null);
	if (prior) {
		const marker = JSON.parse(prior) as { digest?: string };
		if (marker.digest === wanted.digest) return;
		throw new Error("remote execution mirror belongs to a different stage");
	}
	await materializeRemoteStage({ stagePath, executionPath, gitPath });
}

async function writeExit(path: string, value: string): Promise<void> {
	const handle = await open(path, "wx", 0o600).catch(() => null);
	if (!handle) return;
	try {
		await handle.writeFile(value);
	} finally {
		await handle.close();
	}
}

async function run(configPath: string): Promise<void> {
	const config = JSON.parse(
		await readFile(configPath, "utf8"),
	) as RuntimeConfig;
	const secrets = Object.fromEntries(
		(config.secretNames ?? []).map((name) => [name, process.env[name] ?? ""]),
	);
	await mkdir(config.runDir, { recursive: true, mode: 0o700 });
	const launchMarker = await open(
		join(config.runDir, "launch"),
		"wx",
		0o600,
	).catch(() => null);
	if (!launchMarker) return;
	try {
		await launchMarker.writeFile(`${process.pid}\n`);
	} finally {
		await launchMarker.close();
	}
	await writeFile(
		join(config.runDir, "driver.json"),
		`${JSON.stringify(config.driver, null, 2)}\n`,
		{ mode: 0o600 },
	);
	for (const file of [
		"events.jsonl",
		"raw.log",
		"steer.jsonl",
		"control.jsonl",
	]) {
		await writeFile(join(config.runDir, file), "", { flag: "a", mode: 0o600 });
	}
	await writeFile(join(config.runDir, "pid"), `${process.pid}\n`, {
		mode: 0o600,
	});
	const raw = await open(join(config.runDir, "raw.log"), "a");
	const rawSink = new SerializedChannelSink(async (text) => {
		await raw.writeFile(text);
	});
	try {
		const child = Bun.spawn(
			["bun", "run", config.driverScript, config.runDir],
			{
				cwd: config.executionPath,
				env: process.env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [, , code] = await Promise.all([
			copyRedacted(child.stdout, "stdout", rawSink, secrets),
			copyRedacted(child.stderr, "stderr", rawSink, secrets),
			child.exited,
		]);
		await rawSink.drain();
		await redactEvidenceFile(join(config.runDir, "events.jsonl"), secrets);
		await writeExit(join(config.runDir, "exit"), `exit:${code}`);
	} catch {
		await writeExit(join(config.runDir, "exit"), "exit:1");
	} finally {
		await raw.close();
	}
}

async function observe(runDir: string): Promise<void> {
	const exit = await readFile(join(runDir, "exit"), "utf8").catch(() => null);
	if (exit !== null) {
		process.stdout.write(
			`${JSON.stringify({ state: "exited", exit: exit.trim() })}\n`,
		);
		return;
	}
	const pid = Number((await readFile(join(runDir, "pid"), "utf8")).trim());
	try {
		process.kill(pid, 0);
		process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
	} catch {
		process.stdout.write(`${JSON.stringify({ state: "unknown" })}\n`);
	}
}

async function control(runDir: string, encoded: string): Promise<void> {
	const command = JSON.parse(
		Buffer.from(encoded, "base64").toString("utf8"),
	) as {
		type: string;
		reason?: string;
	};
	if (command.type === "kill") {
		const pid = Number((await readFile(join(runDir, "pid"), "utf8")).trim());
		await writeExit(
			join(runDir, "exit"),
			`killed:${command.reason ?? "remote"}`,
		);
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// A concurrently completed process is represented by its existing exit.
		}
		return;
	}
	const file = command.type === "steer" ? "steer.jsonl" : "control.jsonl";
	const payload =
		command.type === "steer"
			? JSON.stringify((command as { message?: string }).message ?? "")
			: JSON.stringify(command);
	await appendFile(join(runDir, file), `${payload}\n`);
}

const [mode, ...args] = process.argv.slice(2);
switch (mode) {
	case "stage":
		await stage(args[0] as string, args[1] as string, args[2] as string);
		break;
	case "run":
		await run(args[0] as string);
		break;
	case "observe":
		await observe(args[0] as string);
		break;
	case "control":
		await control(args[0] as string, args[1] as string);
		break;
	case "collect": {
		const result = await createRemoteCollection({
			executionPath: args[0] as string,
			runDir: args[1] as string,
			stagePath: args[2] as string,
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
		break;
	}
	default:
		throw new Error("unknown mfw remote runtime mode");
}
