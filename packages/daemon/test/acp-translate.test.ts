import { describe, expect, test } from "bun:test";
import type {
	PermissionOption,
	RequestPermissionRequest,
	SessionConfigOption,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
	approvalKind,
	authFailureMessage,
	autoApprove,
	buildInitializeRequest,
	classifyTool,
	decisionOutcome,
	deepMerge,
	findSelectOption,
	isAuthRequired,
	isMcpServerTool,
	mergeCursorCli,
	mergeCursorMcp,
	mergePiMcp,
	modelNotOfferedMessage,
	opencodeConfigContent,
	PolicyTracker,
	parseEndpoint,
	parseMcpConfig,
	parsePolicy,
	permissionTitle,
	pickModelValue,
	pickThoughtValue,
	piEndpointExtension,
	piPolicyFlags,
	piWrapperScript,
	policyDecision,
	profileFor,
	promptUsageEvent,
	renderDiff,
	selectReadOnlyMode,
	shellQuote,
	stopReasonStatus,
	UpdateTranslator,
	wantsModel,
} from "../src/agents/acp-translate.ts";

const options: PermissionOption[] = [
	{ optionId: "a", name: "Always", kind: "allow_always" },
	{ optionId: "o", name: "Once", kind: "allow_once" },
	{ optionId: "r", name: "No", kind: "reject_once" },
];

function chunk(kind: string, text: string): SessionUpdate {
	return {
		sessionUpdate: kind,
		content: { type: "text", text },
	} as SessionUpdate;
}

describe("profiles and initialize", () => {
	test("known profiles keep their id, unknown ones are generic acp", () => {
		expect(profileFor("cursor-agent").id).toBe("cursor-agent");
		expect(profileFor("gemini-cli").id).toBe("gemini-cli");
		expect(profileFor("opencode").id).toBe("opencode");
		expect(profileFor("nope").id).toBe("acp");
		expect(profileFor(undefined).id).toBe("acp");
	});

	test("advertises no fs or terminal; only cursor sets the model picker meta", () => {
		const generic = buildInitializeRequest(profileFor(undefined));
		expect(generic.clientCapabilities).toEqual({});
		const cursor = buildInitializeRequest(profileFor("cursor-agent"));
		expect(cursor.clientCapabilities?.fs).toBeUndefined();
		expect(cursor.clientCapabilities?.terminal).toBeUndefined();
		expect(cursor.clientCapabilities?._meta).toEqual({
			parameterizedModelPicker: true,
		});
	});
});

describe("stop reasons and errors", () => {
	test("maps stop reasons", () => {
		expect(stopReasonStatus("end_turn")).toEqual({ status: "completed" });
		expect(stopReasonStatus("cancelled")).toEqual({ status: "interrupted" });
		for (const reason of [
			"max_tokens",
			"max_turn_requests",
			"refusal",
		] as const) {
			const mapped = stopReasonStatus(reason);
			expect(mapped.status).toBe("completed");
			expect(mapped.notice).toContain(reason);
		}
	});

	test("detects auth_required by code or prose", () => {
		expect(isAuthRequired({ code: -32000, message: "x" })).toBeTrue();
		expect(isAuthRequired(new Error("Authentication required"))).toBeTrue();
		expect(isAuthRequired(new Error("boom"))).toBeFalse();
	});

	test("auth message names the sign-in methods", () => {
		const message = authFailureMessage(profileFor("gemini-cli"), [
			{ name: "Google login" },
		]);
		expect(message).toContain("Gemini CLI needs authentication");
		expect(message).toContain("sign in through the agent's own CLI");
		expect(message).toContain("Google login");
	});
});

describe("config options", () => {
	const config: SessionConfigOption[] = [
		{
			id: "m",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: "x",
			options: [
				{
					group: "g",
					name: "Group",
					options: [{ value: "x", name: "X" }],
				},
				{ value: "y", name: "Y" },
			] as never,
		},
		{
			id: "t",
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: "low",
			options: [
				{ value: "lo", name: "Low" },
				{ value: "hi", name: "High" },
			],
		},
	];

	test("finds select options, flattening groups", () => {
		const model = findSelectOption(config, "model");
		expect(model?.id).toBe("m");
		expect(model?.values.map((v) => v.value)).toEqual(["x", "y"]);
		expect(findSelectOption(config, "mode")).toBeUndefined();
		expect(findSelectOption(undefined, "model")).toBeUndefined();
	});

	test("model selection is exact, then case-insensitive, never fuzzy", () => {
		const values = findSelectOption(config, "model")?.values ?? [];
		expect(pickModelValue(values, "x")).toBe("x");
		expect(pickModelValue(values, "Y")).toBe("y");
		expect(pickModelValue(values, "z")).toBeUndefined();
		expect(
			modelNotOfferedMessage(profileFor(undefined), "z", values),
		).toContain("x, y");
	});

	test("default and empty models are not applied", () => {
		expect(wantsModel("default")).toBeFalse();
		expect(wantsModel("")).toBeFalse();
		expect(wantsModel(undefined)).toBeFalse();
		expect(wantsModel("mock-smart")).toBeTrue();
	});

	test("thought level matches value or name", () => {
		const values = findSelectOption(config, "thought_level")?.values ?? [];
		expect(pickThoughtValue(values, "HIGH")).toBe("hi");
		expect(pickThoughtValue(values, "lo")).toBe("lo");
		expect(pickThoughtValue(values, "max")).toBeUndefined();
	});

	test("effort none also matches a level named off", () => {
		const off = [
			{ value: "off", name: "off" },
			{ value: "low", name: "low" },
		];
		expect(pickThoughtValue(off, "none")).toBe("off");
		expect(pickThoughtValue(off, "NONE")).toBe("off");
		expect(pickThoughtValue(off, "off")).toBe("off");
		// Without an off level, none matches nothing; off is not an alias of low.
		expect(pickThoughtValue([{ value: "low", name: "low" }], "none")).toBe(
			undefined,
		);
	});
});

describe("permissions", () => {
	test("kind mapping", () => {
		expect(approvalKind("execute")).toBe("command");
		expect(approvalKind("edit")).toBe("file_change");
		expect(approvalKind("delete")).toBe("file_change");
		expect(approvalKind("move")).toBe("file_change");
		expect(approvalKind("read")).toBe("other");
		expect(approvalKind(undefined)).toBe("other");
	});

	test("title falls back to the tool kind", () => {
		const request = {
			sessionId: "s",
			toolCall: { toolCallId: "t", kind: "fetch" },
			options,
		} as RequestPermissionRequest;
		expect(permissionTitle(request)).toBe("fetch");
	});

	test("autonomous prefers allow_once over allow_always", () => {
		expect(autoApprove(options)).toEqual({
			accepted: true,
			response: { outcome: { outcome: "selected", optionId: "o" } },
		});
		expect(autoApprove([options[0] as PermissionOption]).accepted).toBeTrue();
	});

	test("autonomous rejects when nothing allows", () => {
		const result = autoApprove([options[2] as PermissionOption]);
		expect(result.accepted).toBeFalse();
		expect(result.response).toEqual({
			outcome: { outcome: "selected", optionId: "r" },
		});
		expect(autoApprove([]).response.outcome.outcome).toBe("cancelled");
	});

	test("decisions map to options", () => {
		const pick = (decision: string, from = options) => {
			const { response, status } = decisionOutcome(decision, from);
			return [
				response.outcome.outcome === "selected"
					? response.outcome.optionId
					: "cancelled",
				status,
			];
		};
		expect(pick("accept")).toEqual(["o", "accepted"]);
		expect(pick("acceptForSession")).toEqual(["a", "accepted"]);
		expect(pick("acceptForSession", [options[1] as PermissionOption])).toEqual([
			"o",
			"accepted",
		]);
		expect(pick("decline")).toEqual(["r", "declined"]);
		expect(
			pick("decline", [{ optionId: "ra", name: "x", kind: "reject_always" }]),
		).toEqual(["ra", "declined"]);
		expect(pick("decline", [options[0] as PermissionOption])).toEqual([
			"cancelled",
			"cancelled",
		]);
		expect(pick("cancel")).toEqual(["cancelled", "cancelled"]);
	});
});

describe("update translation", () => {
	test("message chunks accumulate until another kind of update arrives", () => {
		const t = new UpdateTranslator();
		expect(t.handle(chunk("agent_message_chunk", "Hel"))).toEqual([]);
		expect(t.handle(chunk("agent_message_chunk", "lo"))).toEqual([]);
		expect(t.handle(chunk("agent_thought_chunk", "hmm"))).toEqual([
			{ type: "message", role: "assistant", text: "Hello" },
		]);
		expect(
			t.handle({
				sessionUpdate: "tool_call",
				toolCallId: "1",
				title: "T",
				kind: "execute",
				status: "in_progress",
			}),
		).toEqual([
			{ type: "thinking", text: "hmm" },
			{ type: "tool_call", id: "1", name: "execute", input: { title: "T" } },
		]);
		expect(t.lastResultText).toBe("Hello");
	});

	test("a pending call with empty input waits for its first update (opencode)", () => {
		// Shapes captured from opencode 1.19.5 over ACP.
		const t = new UpdateTranslator();
		expect(
			t.handle({
				sessionUpdate: "tool_call",
				toolCallId: "w",
				title: "write",
				kind: "edit",
				status: "pending",
				locations: [],
				rawInput: {},
			}),
		).toEqual([]);
		expect(
			t.handle({
				sessionUpdate: "tool_call_update",
				toolCallId: "w",
				status: "in_progress",
				kind: "edit",
				title: "write",
				locations: [{ path: "/w/hello.txt" }],
				rawInput: { filePath: "/w/hello.txt", content: "hi\n" },
			}),
		).toEqual([
			{
				type: "tool_call",
				id: "w",
				name: "edit",
				input: { filePath: "/w/hello.txt", content: "hi\n" },
			},
		]);
		expect(
			t.handle({
				sessionUpdate: "tool_call_update",
				toolCallId: "w",
				status: "completed",
				title: "w/hello.txt",
				content: [
					{
						type: "content",
						content: { type: "text", text: "Wrote file successfully." },
					},
				],
			}),
		).toEqual([
			{
				type: "file_change",
				id: "w",
				phase: "completed",
				status: "completed",
				changes: [{ path: "/w/hello.txt", kind: "unknown" }],
			},
			{
				type: "tool_result",
				id: "w",
				ok: true,
				output: "Wrote file successfully.",
			},
		]);
	});

	test("flush announces a call that never received input", () => {
		const t = new UpdateTranslator();
		t.handle({
			sessionUpdate: "tool_call",
			toolCallId: "p",
			title: "bash",
			kind: "execute",
			status: "pending",
		});
		expect(t.flush()).toEqual([
			{ type: "tool_call", id: "p", name: "execute", input: { title: "bash" } },
		]);
		expect(t.flush()).toEqual([]);
	});

	test("flush ends a turn and records the result text", () => {
		const t = new UpdateTranslator();
		t.beginTurn();
		t.handle(chunk("agent_message_chunk", "final"));
		expect(t.flush()).toEqual([
			{ type: "message", role: "assistant", text: "final" },
		]);
		expect(t.flush()).toEqual([]);
		expect(t.lastResultText).toBe("final");
		t.beginTurn();
		expect(t.lastResultText).toBeUndefined();
	});

	test("tool results, progress and credential redaction", () => {
		const t = new UpdateTranslator();
		const [call] = t.handle({
			sessionUpdate: "tool_call",
			toolCallId: "1",
			title: "T",
			kind: "execute",
			rawInput: { command: "ls", apiToken: "s3cret" },
		});
		expect(call).toMatchObject({ input: { apiToken: "[REDACTED]" } });
		expect(
			t.handle({
				sessionUpdate: "tool_call_update",
				toolCallId: "1",
				status: "in_progress",
				content: [{ type: "content", content: { type: "text", text: "..." } }],
			}),
		).toEqual([{ type: "tool_progress", id: "1", output: "..." }]);
		expect(
			t.handle({
				sessionUpdate: "tool_call_update",
				toolCallId: "1",
				status: "failed",
				rawOutput: { code: 2 },
			}),
		).toEqual([
			{ type: "tool_result", id: "1", ok: false, output: '{"code":2}' },
		]);
	});

	test("diff content becomes a file_change once", () => {
		const t = new UpdateTranslator();
		const update = {
			sessionUpdate: "tool_call_update",
			toolCallId: "e",
			status: "completed",
			content: [{ type: "diff", path: "a.txt", oldText: null, newText: "hi" }],
		} as SessionUpdate;
		const first = t.handle(update);
		// An update for a call never opened is announced first.
		expect(first.shift()).toMatchObject({ type: "tool_call", id: "e" });
		expect(first[0]).toMatchObject({
			type: "file_change",
			id: "e",
			phase: "completed",
			changes: [{ path: "a.txt", kind: "add" }],
		});
		expect(first[1]).toMatchObject({ type: "tool_result", ok: true });
		expect(t.handle(update).map((e) => e.type)).toEqual(["tool_result"]);
	});

	test("renderDiff marks added files and caps size", () => {
		expect(renderDiff("f", null, "n")).toBe("--- /dev/null\n+++ b/f\n+n");
		expect(renderDiff("f", "o", "n")).toBe("--- a/f\n+++ b/f\n-o\n+n");
		expect(renderDiff("f", null, "x".repeat(200_000)).length).toBeLessThan(
			70_000,
		);
	});

	test("plan and usage", () => {
		const t = new UpdateTranslator();
		expect(
			t.handle({
				sessionUpdate: "plan",
				entries: [{ content: "a", priority: "high", status: "in_progress" }],
			}),
		).toEqual([
			{ type: "plan", steps: [{ step: "a", status: "in_progress" }] },
		]);
		expect(
			t.handle({
				sessionUpdate: "usage_update",
				used: 1,
				size: 2,
				cost: { amount: 0.5, currency: "USD" },
			}),
		).toEqual([{ type: "usage", cumulative: true, costUsd: 0.5 }]);
		expect(
			t.handle({
				sessionUpdate: "usage_update",
				used: 1,
				size: 2,
				cost: { amount: 1, currency: "EUR" },
			}),
		).toEqual([]);
		expect(
			promptUsageEvent({
				totalTokens: 3,
				inputTokens: 1,
				outputTokens: 2,
				thoughtTokens: 4,
				cachedReadTokens: 5,
			}),
		).toEqual({
			type: "usage",
			inputTokens: 1,
			outputTokens: 2,
			cachedInputTokens: 5,
			reasoningOutputTokens: 4,
		});
		expect(promptUsageEvent(undefined)).toBeUndefined();
	});

	test("ignored and unknown update kinds produce nothing", () => {
		const t = new UpdateTranslator();
		for (const kind of [
			"user_message_chunk",
			"available_commands_update",
			"current_mode_update",
			"config_option_update",
			"session_info_update",
			"something_new",
		])
			expect(t.handle({ sessionUpdate: kind } as never)).toEqual([]);
	});
});

describe("tool policy classification", () => {
	const servers = ["mfw_brain"];
	const allowed = (kind: string | undefined, title = "t", rawInput?: unknown) =>
		classifyTool("read-only", { kind, title, rawInput }, servers).allowed;

	test("parses the policy, defaulting to full", () => {
		expect(parsePolicy(undefined)).toBe("full");
		expect(parsePolicy("read-only")).toBe("read-only");
		expect(parsePolicy("none")).toBe("none");
		expect(parsePolicy("bogus")).toBe("full");
	});

	test("read-only allows read, search and think", () => {
		for (const kind of ["read", "search", "think"])
			expect(allowed(kind)).toBeTrue();
	});

	test("read-only denies everything that can act, including unknown kinds", () => {
		for (const kind of [
			"edit",
			"delete",
			"move",
			"execute",
			"fetch",
			"switch_mode",
			undefined,
		])
			expect(allowed(kind)).toBeFalse();
		expect(allowed("other", "random_tool")).toBeFalse();
	});

	test("read-only allows `other` only for the brain MCP server's tools", () => {
		expect(allowed("other", "mfw_brain_board_read")).toBeTrue();
		expect(allowed("other", "mfw_brain__board_read")).toBeTrue();
		expect(allowed("other", "mcp__mfw_brain__board_read")).toBeTrue();
		expect(
			allowed("other", "board", { providerIdentifier: "mfw_brain" }),
		).toBeTrue();
		expect(allowed("other", "mfw_brainy")).toBeFalse();
		expect(
			allowed("other", "board", { providerIdentifier: "other" }),
		).toBeFalse();
		// An MCP name never rescues a mutating kind.
		expect(allowed("edit", "mfw_brain_board_write")).toBeFalse();
		expect(isMcpServerTool({ title: "x_y" }, [])).toBeFalse();
	});

	test("none denies everything; full allows everything", () => {
		expect(classifyTool("none", { kind: "read" }, servers).allowed).toBeFalse();
		expect(
			classifyTool("none", { kind: "other", title: "mfw_brain_x" }, servers)
				.allowed,
		).toBeFalse();
		expect(
			classifyTool("full", { kind: "execute" }, servers).allowed,
		).toBeTrue();
	});

	function request(kind: string, title: string, opts = options) {
		return {
			sessionId: "s",
			toolCall: { toolCallId: "c1", title, kind },
			options: opts,
		} as RequestPermissionRequest;
	}

	test("a decision allows with allow_once and denies with reject_once", () => {
		const yes = policyDecision("read-only", request("read", "Read a"), servers);
		expect(yes.accepted).toBeTrue();
		expect(yes.response).toEqual({
			outcome: { outcome: "selected", optionId: "o" },
		});
		expect(yes.summary).toStartWith("Read-only policy: allowed");
		const no = policyDecision(
			"read-only",
			request("fetch", "Fetch u"),
			servers,
		);
		expect(no.accepted).toBeFalse();
		expect(no.response).toEqual({
			outcome: { outcome: "selected", optionId: "r" },
		});
		expect(no.summary).toStartWith("Read-only policy: denied");
	});

	test("a denial falls back to reject_always, then cancelled", () => {
		const always: PermissionOption[] = [
			{ optionId: "x", name: "No always", kind: "reject_always" },
		];
		expect(
			policyDecision("none", request("read", "r", always), servers).response,
		).toEqual({ outcome: { outcome: "selected", optionId: "x" } });
		const allowOnly = options.filter((o) => o.kind.startsWith("allow"));
		expect(
			policyDecision("none", request("read", "r", allowOnly), servers).response,
		).toEqual({ outcome: { outcome: "cancelled" } });
	});

	test("the tracker flags a denied call that completes unasked, merging updates", () => {
		const t = new PolicyTracker("read-only", servers);
		const call = (u: Record<string, unknown>) =>
			t.observe({ toolCallId: "c", ...u } as SessionUpdate);
		expect(
			call({
				sessionUpdate: "tool_call",
				kind: "edit",
				title: "Write a",
				status: "pending",
			}),
		).toBeUndefined();
		// opencode: in_progress and failed are not violations.
		expect(
			call({ sessionUpdate: "tool_call_update", status: "in_progress" }),
		).toBeUndefined();
		expect(
			call({ sessionUpdate: "tool_call_update", status: "failed" }),
		).toBeUndefined();
		t.reset();
		call({
			sessionUpdate: "tool_call",
			kind: "edit",
			title: "Write a",
			status: "in_progress",
		});
		expect(
			call({ sessionUpdate: "tool_call_update", status: "completed" }),
		).toBe(
			"read-only policy violated: edit tool 'Write a' ran without permission",
		);
	});

	test("the tracker lets allowed kinds and granted calls complete", () => {
		const t = new PolicyTracker("read-only", servers);
		const done = (id: string, kind: string, title = "x") =>
			t.observe({
				sessionUpdate: "tool_call",
				toolCallId: id,
				kind,
				title,
				status: "completed",
			} as SessionUpdate);
		expect(done("a", "read")).toBeUndefined();
		expect(done("b", "other", "mfw_brain_board_read")).toBeUndefined();
		t.grant("g");
		t.observe({
			sessionUpdate: "tool_call_update",
			toolCallId: "g",
			status: "in_progress",
		} as SessionUpdate);
		expect(
			t.observe({
				sessionUpdate: "tool_call_update",
				toolCallId: "g",
				kind: "execute",
				status: "completed",
			} as SessionUpdate),
		).toBeUndefined();
		expect(done("c", "execute", "Run ls")).toContain("execute tool 'Run ls'");
		// Under none a read the agent ran unasked is tolerated; a mutation is not.
		const none = new PolicyTracker("none", servers);
		expect(
			none.observe({
				sessionUpdate: "tool_call",
				toolCallId: "r",
				kind: "read",
				title: "Read f",
				status: "completed",
			} as SessionUpdate),
		).toBeUndefined();
		expect(
			none.observe({
				sessionUpdate: "tool_call",
				toolCallId: "w",
				kind: "edit",
				title: "Write f",
				status: "completed",
			} as SessionUpdate),
		).toContain("edit tool 'Write f'");
		// The full policy never flags anything.
		expect(
			new PolicyTracker("full", servers).observe({
				sessionUpdate: "tool_call",
				toolCallId: "f",
				kind: "execute",
				status: "completed",
			} as SessionUpdate),
		).toBeUndefined();
	});
});

describe("session setup helpers", () => {
	test("parseMcpConfig converts to stdio entries and never echoes env in errors", () => {
		const servers = parseMcpConfig(
			JSON.stringify({
				mcpServers: { brain: { command: "bun", args: ["a"], env: { K: "v" } } },
			}),
		);
		expect(servers).toEqual([
			{
				name: "brain",
				command: "bun",
				args: ["a"],
				env: [{ name: "K", value: "v" }],
			},
		]);
		expect(() => parseMcpConfig("nope")).toThrow("not valid JSON");
		expect(() => parseMcpConfig("{}")).toThrow("no mcpServers");
		expect(() =>
			parseMcpConfig(
				JSON.stringify({ mcpServers: { x: { env: { K: "secret" } } } }),
			),
		).toThrow("server 'x' has no command");
	});

	test("deepMerge lets the override win and merges nested objects", () => {
		expect(
			deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }),
		).toEqual({ a: { b: 1, c: 3 }, d: [2] });
	});

	test("opencode config merges inherited, read-only permissions and the endpoint", () => {
		expect(
			opencodeConfigContent(undefined, { restricted: false }),
		).toBeUndefined();
		const merged = JSON.parse(
			opencodeConfigContent('{"permission":{"read":"allow","edit":"allow"}}', {
				restricted: true,
				endpoint: { id: "e", baseUrl: "http://h/v1" },
				model: "m",
			}) ?? "",
		);
		expect(merged.permission).toEqual({
			read: "allow",
			edit: "deny",
			bash: "deny",
			webfetch: "deny",
			task: "deny",
			external_directory: "deny",
			websearch: "deny",
			codesearch: "deny",
		});
		// No envKey, no apiKey.
		expect(merged.provider["mfw-e"].options).toEqual({
			baseURL: "http://h/v1",
		});
		expect(() => opencodeConfigContent("[", { restricted: true })).toThrow();
		expect(() =>
			opencodeConfigContent(undefined, {
				restricted: false,
				endpoint: { id: "e", baseUrl: "u" },
			}),
		).toThrow("needs a model");
	});

	test("parseEndpoint validates the JSON", () => {
		expect(parseEndpoint(undefined)).toBeNull();
		expect(parseEndpoint('{"id":"e","baseUrl":"u","envKey":"K"}')).toEqual({
			id: "e",
			baseUrl: "u",
			envKey: "K",
		});
		expect(() => parseEndpoint("{")).toThrow();
		expect(() => parseEndpoint('{"id":"e"}')).toThrow("baseUrl");
	});

	test("cursor config merges keep user entries and union permissions", () => {
		const mcp = JSON.parse(
			mergeCursorMcp(
				'{"mcpServers":{"mine":{"command":"x"},"brain":{"command":"old"}}}',
				[{ name: "brain", command: "bun", args: [], env: [] }],
			),
		);
		expect(mcp.mcpServers.mine).toEqual({ command: "x" });
		expect(mcp.mcpServers.brain).toEqual({ command: "bun", args: [], env: {} });
		expect(() => mergeCursorMcp("[]", [])).toThrow();
		const cli = JSON.parse(mergeCursorCli(undefined, "read-only", ["brain"]));
		expect(cli.permissions).toEqual({
			allow: ["Read(**)", "Mcp(brain:*)"],
			deny: ["Shell(*)", "Write(**)", "WebFetch(*)"],
		});
		expect(
			JSON.parse(mergeCursorCli(undefined, "none", ["brain"])).permissions
				.allow,
		).toEqual(["Read(**)"]);
	});

	test("read-only mode comes from modes first, then a mode config option", () => {
		const modes = { availableModes: [{ id: "default" }, { id: "plan" }] };
		expect(selectReadOnlyMode(modes, null, "plan")).toEqual({
			via: "mode",
			modeId: "plan",
		});
		const option = {
			id: "mode",
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: "default",
			options: [{ value: "plan", name: "Plan" }],
		} as SessionConfigOption;
		expect(selectReadOnlyMode(null, [option], "plan")).toEqual({
			via: "option",
			configId: "mode",
			value: "plan",
		});
		expect(selectReadOnlyMode(null, null, "plan")).toBeUndefined();
		expect(
			selectReadOnlyMode({ availableModes: [{ id: "x" }] }, [option], "ask"),
		).toBeUndefined();
	});

	test("only the three named profiles are brain eligible", () => {
		for (const id of ["cursor-agent", "gemini-cli", "opencode"])
			expect(profileFor(id).brainEligible).toBeTrue();
		expect(profileFor(undefined).brainEligible).toBeFalse();
		expect(profileFor("opencode").readOnlyMode).toBe("plan");
		expect(profileFor("cursor-agent").readOnlyMode).toBe("plan");
		expect(profileFor("gemini-cli").readOnlyMode).toBeUndefined();
	});
});

describe("pi profile helpers", () => {
	test("the pi profile is brain-eligible with no read-only mode", () => {
		const pi = profileFor("pi");
		expect(pi).toMatchObject({ id: "pi", label: "pi", brainEligible: true });
		expect(pi.readOnlyMode).toBeUndefined();
		expect(pi.readOnlyOtherTitles).toEqual(["grep", "find", "ls"]);
		expect(pi.identity?.bin).toBe("pi");
		expect(profileFor("cursor-agent").identity?.bin).toBe("agent");
		expect(profileFor("opencode").identity).toBeUndefined();
	});

	test("read-only allows `other` tools titled by readOnlyOtherTitles only", () => {
		const titles = profileFor("pi").readOnlyOtherTitles;
		const ok = (kind: string, title: string) =>
			classifyTool("read-only", { kind, title }, [], titles).allowed;
		expect(ok("other", "grep")).toBeTrue();
		expect(ok("other", "find")).toBeTrue();
		expect(ok("other", "ls")).toBeTrue();
		expect(ok("other", "write")).toBeFalse();
		expect(ok("other", "bash")).toBeFalse();
		expect(ok("other", "grep -r x")).toBeFalse();
		expect(ok("execute", "ls")).toBeFalse();
		// Other profiles have no such titles.
		expect(
			classifyTool("read-only", { kind: "other", title: "grep" }, []),
		).toMatchObject({ allowed: false });
	});

	test("the tracker uses the profile's titles for violations", () => {
		const done = (title: string) =>
			new PolicyTracker("read-only", [], ["grep"]).observe({
				sessionUpdate: "tool_call",
				toolCallId: "t",
				title,
				kind: "other",
				status: "completed",
			});
		expect(done("grep")).toBeUndefined();
		expect(done("bash")).toContain("other tool 'bash'");
	});

	test("shell quoting survives single quotes", () => {
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	test("policy flags", () => {
		expect(piPolicyFlags("full", ["x"])).toEqual([]);
		expect(piPolicyFlags("none", ["x"])).toEqual([
			"--no-approve",
			"--no-extensions",
			"--no-tools",
			"--no-mcp",
		]);
		expect(piPolicyFlags("read-only", [])).toEqual([
			"--approve",
			"--no-extensions",
			"-e",
			"builtin:mcp",
			"--tools",
			"read,grep,find,ls",
		]);
		expect(piPolicyFlags("read-only", ["a", "b"]).at(-1)).toBe(
			"read,grep,find,ls,mcp__a__*,mcp__b__*",
		);
	});

	test("wrapper script quotes every argument", () => {
		expect(piWrapperScript("/bin/pi x", ["--tools", "a,b", "-e", "f'g"])).toBe(
			`#!/bin/sh\nexec '/bin/pi x' '--tools' 'a,b' '-e' 'f'\\''g' "$@"\n`,
		);
	});

	test("mcp.json keeps existing entries, ours win, exposure direct", () => {
		const out = JSON.parse(
			mergePiMcp(
				JSON.stringify({
					theme: 1,
					mcpServers: { mine: { command: "x" }, s: { command: "old" } },
				}),
				[
					{
						name: "s",
						command: "bun",
						args: ["a"],
						env: [{ name: "K", value: "v" }],
					},
				],
			),
		);
		expect(out).toEqual({
			theme: 1,
			mcpServers: {
				mine: { command: "x" },
				s: { command: "bun", args: ["a"], env: { K: "v" }, exposure: "direct" },
			},
		});
		expect(() => mergePiMcp("[]", [])).toThrow();
	});

	test("endpoint extension registers the provider and never holds the key", () => {
		const text = piEndpointExtension(
			{ id: "ep", baseUrl: "http://h/v1", envKey: "MY_KEY" },
			"m/1",
		);
		expect(text).toStartWith("export default function (pi) {");
		expect(text).toContain('pi.registerProvider("mfw-ep", ');
		const json = text.slice(
			text.indexOf("{", text.indexOf("(", 30) + 1),
			text.lastIndexOf(");"),
		);
		expect(JSON.parse(json)).toEqual({
			name: "mfw ep",
			baseUrl: "http://h/v1",
			api: "openai-completions",
			apiKey: "$MY_KEY",
			models: [
				{
					id: "m/1",
					name: "m/1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		expect(
			piEndpointExtension({ id: "ep", baseUrl: "http://h/v1" }, "m"),
		).not.toContain("apiKey");
	});
});
