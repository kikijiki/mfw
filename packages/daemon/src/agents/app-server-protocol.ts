/** The provider-independent NDJSON boundary used by mfw agent bridges. */
export const APP_SERVER_PROTOCOL = 1 as const;

export type AppServerErrorCode =
	| "UNSUPPORTED"
	| "INVALID_STATE"
	| "PROVIDER_ERROR";

export type AppServerRequest = {
	v: 1;
	id: number;
	method: string;
	params: unknown;
};
export type AppServerResponse =
	| { v: 1; id: number; result: unknown }
	| {
			v: 1;
			id: number;
			error: { code: AppServerErrorCode; message: string };
	  };
export type AppServerNotification = {
	v: 1;
	method: string;
	params: unknown;
};
export type AppServerEnvelope =
	| AppServerRequest
	| AppServerResponse
	| AppServerNotification;

export type AppServerCapabilities = {
	steer: boolean;
	interrupt?: boolean;
	approvals?: boolean;
	plan?: boolean;
	fileChanges?: boolean;
	commandProgress?: boolean;
	mcp?: boolean;
};
export type ApprovalDecision =
	| "accept"
	| "acceptForSession"
	| "decline"
	| "cancel";
export type CanonicalInput = { type: "text"; text: string };

export function parseAppServerEnvelope(line: string): AppServerEnvelope | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1) return null;
	if (
		"id" in value &&
		(typeof value.id !== "number" ||
			!Number.isSafeInteger(value.id) ||
			value.id < 0)
	)
		return null;
	if ("method" in value && typeof value.method !== "string") return null;
	if (!("method" in value) && !("result" in value) && !("error" in value))
		return null;
	return value as AppServerEnvelope;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textInput(value: unknown): CanonicalInput[] | null {
	if (!Array.isArray(value)) return null;
	const result: CanonicalInput[] = [];
	for (const item of value) {
		if (
			!isRecord(item) ||
			item.type !== "text" ||
			typeof item.text !== "string"
		)
			return null;
		result.push({ type: "text", text: item.text });
	}
	return result;
}

export function providerArgv(defaultArgv: string[]): string[] {
	if (process.argv.length > 2) return process.argv.slice(2);
	const encoded = process.env.MFW_PROVIDER_ARGV;
	if (encoded) {
		try {
			const parsed = JSON.parse(encoded);
			if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string"))
				return parsed;
		} catch {
			// The bridge reports the provider spawn failure below; never echo argv.
		}
	}
	return defaultArgv;
}

export function writeEnvelope(envelope: AppServerEnvelope): void {
	process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export function response(id: number, result: unknown): AppServerResponse {
	return { v: 1, id, result };
}

export function rpcError(
	id: number,
	code: AppServerErrorCode,
	message: string,
): AppServerResponse {
	return { v: 1, id, error: { code, message: capText(message, 2048) } };
}

export function notify(method: string, params: unknown): AppServerNotification {
	return { v: 1, method, params };
}

export function capText(text: string, size: number): string {
	return text.length <= size ? text : `${text.slice(0, size)}\n[…truncated…]`;
}

/** Redact credentials and bound arbitrary provider-owned structured values. */
export function sanitize(value: unknown, depth = 0): unknown {
	if (depth >= 6) return "[…truncated…]";
	if (value === null || typeof value === "boolean" || typeof value === "number")
		return value;
	if (typeof value === "string") return capText(value, 64 * 1024);
	if (Array.isArray(value))
		return value.slice(0, 100).map((v) => sanitize(v, depth + 1));
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value).slice(0, 100)) {
			out[key] = /token|secret|password|authorization|cookie/i.test(key)
				? "[REDACTED]"
				: sanitize(child, depth + 1);
		}
		return out;
	}
	return String(value);
}
