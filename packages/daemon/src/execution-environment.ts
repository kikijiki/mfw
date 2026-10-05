import { inspect } from "node:util";

/** Minimal environment valid on a Linux host and a RunPod image. Nothing is copied from the daemon process. */
export const BASE_EXECUTION_ENVIRONMENT = Object.freeze({
	CI: "1",
	GIT_TERMINAL_PROMPT: "0",
	HOME: "/tmp/mfw-home",
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	PATH: "/usr/local/bin:/usr/bin:/bin",
	TERM: "dumb",
});

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class InvalidExecutionEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidExecutionEnvironmentError";
	}
}

function validateEnvironment(input: Readonly<Record<string, string>>): void {
	for (const [name, value] of Object.entries(input)) {
		if (!ENVIRONMENT_NAME.test(name)) {
			throw new InvalidExecutionEnvironmentError(
				`invalid execution environment name '${name}'`,
			);
		}
		if (value.includes("\0")) {
			throw new InvalidExecutionEnvironmentError(
				`execution environment value for '${name}' contains NUL`,
			);
		}
	}
}

function sortedEnvironment(
	input: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Builds from a literal baseline, never `process.env`, so a remote checkout cannot depend on direnv or dotfiles. Used by worktree setup and the driver. */
export class ExecutionEnvironmentBuilder {
	constructor(
		private readonly configured: Readonly<Record<string, string>> = {},
		private readonly baseline: Readonly<
			Record<string, string>
		> = BASE_EXECUTION_ENVIRONMENT,
	) {
		validateEnvironment(baseline);
		validateEnvironment(configured);
	}

	build(
		runtime: Readonly<Record<string, string>> = {},
	): Record<string, string> {
		validateEnvironment(runtime);
		return sortedEnvironment({
			...this.baseline,
			...this.configured,
			...runtime,
		});
	}
}

export function buildExecutionEnvironment(
	configured: Readonly<Record<string, string>> = {},
	runtime: Readonly<Record<string, string>> = {},
): Record<string, string> {
	return new ExecutionEnvironmentBuilder(configured).build(runtime);
}

/** In-memory secret values. JSON and `inspect` expose names only, so logging one cannot leak a credential. */
export class SecretEnvironment {
	readonly #values: Readonly<Record<string, string>>;

	constructor(values: Readonly<Record<string, string>>) {
		validateEnvironment(values);
		this.#values = Object.freeze({ ...values });
	}

	names(): string[] {
		return Object.keys(this.#values).sort();
	}

	isEmpty(): boolean {
		return this.names().length === 0;
	}

	/** Only secret-aware launch transports should call this. */
	materializeForLaunch(): Record<string, string> {
		return { ...this.#values };
	}

	toJSON(): { secretNames: string[] } {
		return { secretNames: this.names() };
	}

	[inspect.custom](): string {
		return `SecretEnvironment(${this.names().join(", ") || "empty"})`;
	}
}

export function redactSecretValues(
	text: string,
	secrets: SecretEnvironment | Readonly<Record<string, string>>,
): string {
	const values =
		secrets instanceof SecretEnvironment
			? secrets.materializeForLaunch()
			: secrets;
	let redacted = text;
	for (const value of [
		...new Set(Object.values(values).filter((value) => value.length > 0)),
	].sort(
		(left, right) => right.length - left.length || left.localeCompare(right),
	)) {
		if (value.length > 0) redacted = redacted.split(value).join("[REDACTED]");
	}
	return redacted;
}

/**
 * Literal secret redaction over byte chunks. A non-final drain holds back the
 * earliest suffix that is a proper prefix of a secret, so no secret straddles
 * a chunk boundary; the decoder persists to keep split multibyte characters intact.
 */
export class StreamingSecretRedactor {
	readonly #decoder = new TextDecoder();
	readonly #values: readonly string[];
	#buffer = "";
	#finished = false;

	constructor(secrets: SecretEnvironment | Readonly<Record<string, string>>) {
		const materialized =
			secrets instanceof SecretEnvironment
				? secrets.materializeForLaunch()
				: secrets;
		this.#values = [
			...new Set(
				Object.values(materialized).filter((value) => value.length > 0),
			),
		].sort(
			(left, right) => right.length - left.length || left.localeCompare(right),
		);
	}

	push(bytes: Uint8Array): string {
		if (this.#finished) throw new Error("secret redactor is already finished");
		this.#buffer += this.#decoder.decode(bytes, { stream: true });
		return this.#drain(false);
	}

	finish(): string {
		if (this.#finished) return "";
		this.#finished = true;
		this.#buffer += this.#decoder.decode();
		return this.#drain(true);
	}

	#drain(final: boolean): string {
		let cutoff = this.#buffer.length;
		if (!final) {
			for (const value of this.#values) {
				for (
					let length = Math.min(value.length - 1, this.#buffer.length);
					length > 0;
					length--
				) {
					if (this.#buffer.endsWith(value.slice(0, length))) {
						cutoff = Math.min(cutoff, this.#buffer.length - length);
						break;
					}
				}
			}
		}
		const output = this.#buffer.slice(0, cutoff);
		this.#buffer = this.#buffer.slice(cutoff);
		return redactSecretValues(
			output,
			Object.fromEntries(this.#values.map((value, index) => [index, value])),
		);
	}
}

/** Serializes independently redacted stdout/stderr fragments into one log, delimiting channel switches so fragments from two streams cannot compose a secret. */
export class SerializedChannelSink {
	#queue: Promise<void> = Promise.resolve();
	#lastChannel: string | null = null;

	constructor(private readonly write: (text: string) => Promise<void>) {}

	append(channel: string, text: string, final = false): Promise<void> {
		const operation = async () => {
			if (text) {
				if (this.#lastChannel !== null && this.#lastChannel !== channel) {
					await this.write("\n");
				}
				await this.write(text);
				this.#lastChannel = channel;
			}
			if (final && this.#lastChannel === channel) {
				await this.write("\n");
				this.#lastChannel = null;
			}
		};
		this.#queue = this.#queue.then(operation);
		return this.#queue;
	}

	drain(): Promise<void> {
		return this.#queue;
	}
}

export function assertDisjointEnvironmentNames(
	publicEnvironment: Readonly<Record<string, string>>,
	secrets: SecretEnvironment,
): void {
	const overlap = secrets.names().filter((name) => name in publicEnvironment);
	if (overlap.length > 0) {
		throw new InvalidExecutionEnvironmentError(
			`secret environment names also appear in public environment: ${overlap.join(", ")}`,
		);
	}
}
