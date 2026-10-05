import { describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SerializedChannelSink,
	StreamingSecretRedactor,
} from "../src/execution-environment.ts";

function chunks(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
	const result: Uint8Array[] = [];
	let offset = 0;
	for (const cut of cuts) {
		result.push(bytes.slice(offset, cut));
		offset = cut;
	}
	result.push(bytes.slice(offset));
	return result;
}

function redact(
	input: string,
	secrets: Readonly<Record<string, string>>,
	cuts: readonly number[],
): string {
	const redactor = new StreamingSecretRedactor(secrets);
	const bytes = new TextEncoder().encode(input);
	return (
		chunks(bytes, cuts)
			.map((chunk) => redactor.push(chunk))
			.join("") + redactor.finish()
	);
}

describe("StreamingSecretRedactor", () => {
	test("redacts a literal at every byte split point", () => {
		const secret = "abcde";
		const input = `before:${secret}:after`;
		const byteLength = new TextEncoder().encode(input).length;
		for (let split = 0; split <= byteLength; split++) {
			const output = redact(input, { TOKEN: secret }, [split]);
			expect(output).toBe("before:[REDACTED]:after");
			expect(output).not.toContain(secret);
		}
	});

	test("handles multibyte splits, prefix-related and overlapping values", () => {
		const input = "x-秘密🔐-abcd-ababa-y";
		const bytes = new TextEncoder().encode(input);
		for (let split = 0; split <= bytes.length; split++) {
			const output = redact(
				input,
				{ A: "秘密🔐", B: "abc", C: "abcd", D: "aba", E: "bab" },
				[split],
			);
			expect(output).not.toContain("秘密🔐");
			expect(output).not.toContain("abc");
			expect(output).not.toContain("abcd");
			expect(output).not.toContain("aba");
			expect(output).not.toContain("bab");
		}
	});

	test("ignores empty values and supports one-byte chunks", () => {
		const input = "prefix-token-suffix";
		const bytes = new TextEncoder().encode(input);
		const cuts = Array.from({ length: bytes.length }, (_, index) => index);
		expect(redact(input, { EMPTY: "", TOKEN: "token" }, cuts)).toBe(
			"prefix-[REDACTED]-suffix",
		);
	});

	test("cross-stream secret splits cannot compose in the persisted log", async () => {
		const secret = "cross-stream-token";
		for (let split = 1; split < secret.length; split++) {
			const root = await mkdtemp(join(tmpdir(), "mfw-redacted-log-"));
			const path = join(root, "raw.log");
			const handle = await open(path, "a", 0o600);
			const sink = new SerializedChannelSink(async (text) => {
				await handle.writeFile(text);
			});
			const stdout = new StreamingSecretRedactor({ TOKEN: secret });
			const stderr = new StreamingSecretRedactor({ TOKEN: secret });
			const stdoutChunk = stdout.push(
				new TextEncoder().encode(secret.slice(0, split)),
			);
			const stderrChunk = stderr.push(
				new TextEncoder().encode(secret.slice(split)),
			);
			// Force the hostile ordering: persist the prefix first, then the suffix.
			await sink.append("stdout", stdoutChunk + stdout.finish(), true);
			await sink.append("stderr", stderrChunk + stderr.finish(), true);
			await sink.drain();
			await handle.close();
			const persisted = await readFile(path, "utf8");
			expect(persisted).not.toContain(secret);
			expect(persisted).toContain("\n");
			await rm(root, { recursive: true, force: true });
		}
	});
});
