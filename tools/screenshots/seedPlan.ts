// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are file contents of dummy repositories
/**
 * What the screenshot run seeds: three small projects with a believable week
 * of work. Pure data (validated by `validateSeedPlan`); `seed.ts` turns it
 * into repositories, boards and history.
 *
 * Every time is "how long before the anchor instant", so the same plan always
 * renders the same relative times ("3h ago") no matter when it runs.
 */

import type { SeedPlan, SeedProject } from "./plan.ts";

const SONNET = "claude-sonnet-4-5";
const OPUS = "claude-opus-4-5";
const HAIKU = "claude-haiku-4-5";
const CODEX = "gpt-5-codex";

/** A small TypeScript HTTP API with rate limiting under construction: the "busy project". */
const harbor: SeedProject = {
	key: "harbor",
	name: "harbor-api",
	template: "mfw-default",
	repo: "harbor",
	budgets: { dailyUsd: 30, weeklyUsd: 140 },
	adrs: [
		{
			title: "Hono as the HTTP framework",
			status: "accepted",
			date: "2026-09-24",
			body: "## Context\n\nThe service is a thin layer over the key store. We need routing, middleware and\ntyped context, and we deploy to Bun.\n\n## Decision\n\nUse Hono. The spike (see `docs/spikes/router.md`) showed it matches Fastify on\nthroughput for our payloads, with a third of the dependency weight.\n\n## Consequences\n\nMiddleware is plain functions over `Context`; no plugin lifecycle to learn.\n",
		},
		{
			title: "Rate limits are enforced per API key, not per IP",
			status: "accepted",
			date: "2026-10-02",
			body: "## Context\n\nCustomers sit behind shared NATs; per-IP limits punish the wrong people.\n\n## Decision\n\nA token bucket per API key, with the bucket parameters stored on the key's\nrecord. Unauthenticated routes fall back to a coarse per-IP bucket.\n\n## Consequences\n\nQuota changes are a write to the key store, not a deploy.\n",
		},
		{
			title: "Quota state lives in Redis, behind a store interface",
			status: "proposed",
			date: "2026-10-08",
			body: "## Context\n\nThe in-memory store cannot be shared between instances.\n\n## Decision\n\nKeep the `QuotaStore` interface and add a Redis implementation; the in-memory\none stays for tests and single-node use.\n",
		},
	],
	tasks: [
		{
			alias: "limits",
			title: "Rate limiting and quotas",
			type: "epic",
			priority: "high",
			status: "in_progress",
			created: "12d",
			labels: ["api", "q4"],
			body: "## Goal\n\nEvery API key is limited by a token bucket and has a monthly quota. Clients see\ntheir limits in response headers and operators can adjust a key without a deploy.\n\n## Out of scope\n\nBilling. Per-endpoint limits.\n",
			moves: [{ ago: "11d", to: "in_progress", actor: "human" }],
		},
		{
			alias: "bucket",
			title: "Token-bucket limiter middleware",
			priority: "high",
			size: "m",
			status: "done",
			parent: "limits",
			created: "12d",
			labels: ["api"],
			owns: [
				"src/limiter/**",
				"src/middleware/rateLimit.ts",
				"test/tokenBucket.test.ts",
			],
			body: "## Goal\n\nA Hono middleware that rejects with 429 when a key's bucket is empty.\n\n## Notes\n\nBurst and refill rate come from the key record. Use a monotonic clock.\n",
			criteria: [
				"Requests over the burst get 429 with Retry-After",
				"Refill is covered by a fake-clock test",
			],
			moves: [
				{ ago: "11d", to: "ready", actor: "scheduler" },
				{ ago: "10d2h", to: "in_progress", actor: "scheduler" },
				{ ago: "9d23h", to: "review", actor: "verifier" },
				{ ago: "9d22h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "store",
			title: "Per-key quota storage",
			priority: "high",
			size: "m",
			status: "done",
			parent: "limits",
			dependsOn: ["bucket"],
			created: "12d",
			labels: ["api", "storage"],
			owns: ["src/store/**"],
			body: "## Goal\n\nPersist bucket state and monthly counters per key behind a `QuotaStore`\ninterface, with an in-memory implementation.\n",
			criteria: ["Counters survive a process restart in the file-backed store"],
			moves: [
				{ ago: "9d22h", to: "ready", actor: "scheduler" },
				{ ago: "9d4h", to: "in_progress", actor: "scheduler" },
				{ ago: "8d22h", to: "review", actor: "verifier" },
				{ ago: "8d21h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "headers",
			title: "Expose quota headers (X-RateLimit-*)",
			priority: "high",
			size: "s",
			status: "in_progress",
			parent: "limits",
			dependsOn: ["store"],
			created: "11d",
			labels: ["api"],
			owns: ["src/middleware/rateLimitHeaders.ts"],
			body: "## Goal\n\nEvery response carries `X-RateLimit-Limit`, `-Remaining` and `-Reset`, so clients\ncan back off before they are rejected.\n",
			criteria: [
				"Headers present on 200 and 429 responses",
				"Reset is a unix timestamp in seconds",
			],
			moves: [
				{ ago: "8d21h", to: "ready", actor: "scheduler" },
				{ ago: "34m", to: "in_progress", actor: "scheduler" },
			],
		},
		{
			alias: "admin",
			title: "Admin endpoint to adjust a key's quota",
			priority: "medium",
			size: "m",
			status: "review",
			parent: "limits",
			dependsOn: ["store"],
			created: "11d",
			labels: ["api", "admin"],
			owns: ["src/routes/admin.ts", "test/admin.test.ts"],
			body: "## Goal\n\n`PATCH /admin/keys/:id/quota` changes a key's burst, refill rate and monthly\nquota. Admin tokens only.\n\n## Notes\n\nAudit-log every change with the actor.\n",
			criteria: [
				"Non-admin tokens get 403",
				"The change takes effect on the next request",
				"Every change is audit-logged",
			],
			moves: [
				{ ago: "8d21h", to: "ready", actor: "scheduler" },
				{ ago: "1d3h", to: "in_progress", actor: "scheduler" },
				{
					ago: "2h10m",
					to: "review",
					actor: "verifier",
					reason: "human review required",
				},
			],
		},
		{
			alias: "loadtest",
			title: "Load-test harness for the limiter",
			priority: "medium",
			size: "s",
			status: "ready",
			parent: "limits",
			dependsOn: ["bucket"],
			created: "10d",
			labels: ["testing"],
			body: "## Goal\n\nA `bun run loadtest` script that drives N keys at a fixed rate and prints the\n429 ratio, so a limiter change can be checked against a number.\n",
			moves: [{ ago: "9d22h", to: "ready", actor: "scheduler" }],
		},
		{
			alias: "openapi",
			title: "Document quota errors in the OpenAPI spec",
			priority: "low",
			size: "xs",
			status: "backlog",
			parent: "limits",
			dependsOn: ["headers"],
			created: "10d",
			labels: ["docs"],
			body: "## Goal\n\nThe 429 response and the three headers appear in `docs/openapi.yaml`.\n",
		},
		{
			alias: "webhooks",
			title: "Webhook delivery retries with backoff",
			priority: "high",
			size: "l",
			status: "in_progress",
			created: "5d",
			labels: ["webhooks"],
			owns: ["src/webhooks/**"],
			body: "## Goal\n\nA failed webhook delivery is retried with exponential backoff and jitter, up to\n8 attempts over about a day, then parked in a dead-letter list.\n",
			criteria: [
				"Backoff is exponential with full jitter",
				"After the last attempt the delivery lands in the dead-letter list",
				"Retries survive a restart",
			],
			moves: [
				{ ago: "4d", to: "ready", actor: "scheduler" },
				{ ago: "3h", to: "in_progress", actor: "scheduler" },
			],
		},
		{
			alias: "cursors",
			title: "Cursor-based pagination for GET /keys",
			priority: "medium",
			size: "m",
			status: "in_progress",
			created: "4d",
			labels: ["api"],
			owns: ["src/routes/keys.ts", "src/lib/cursor.ts", "test/cursor.test.ts"],
			body: "## Goal\n\nReplace `?page=` with opaque cursors so listing stays stable while keys are\ncreated. Two approaches are plausible, so the brain tried both.\n",
			criteria: [
				"Cursors are opaque and URL-safe",
				"Listing during concurrent inserts never repeats or skips a key",
			],
			moves: [
				{ ago: "3d", to: "ready", actor: "scheduler" },
				{ ago: "40m", to: "in_progress", actor: "brain" },
			],
		},
		{
			alias: "flaky",
			title: "Fix flaky session-store test",
			type: "maintenance",
			priority: "medium",
			size: "s",
			status: "blocked",
			created: "3d",
			labels: ["ci"],
			blockedReason: "Needs a Redis instance in CI; waiting on infra access.",
			body: "## Goal\n\n`session-store.test.ts` fails about one run in ten on CI. Find the race.\n",
			moves: [
				{ ago: "2d3h", to: "in_progress", actor: "scheduler" },
				{
					ago: "2d",
					to: "blocked",
					actor: "brain",
					reason: "needs Redis in CI",
				},
			],
		},
		{
			alias: "router",
			title: "Spike: Hono vs Fastify for the router",
			type: "spike",
			priority: "medium",
			size: "s",
			status: "done",
			created: "12d",
			labels: ["research"],
			body: "## Question\n\nDoes Hono hold up against Fastify at our payload sizes, and what does each\ncost in dependencies?\n",
			moves: [
				{ ago: "11d2h", to: "in_progress", actor: "scheduler" },
				{ ago: "11d", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "bun",
			title: "Upgrade Bun to 1.3",
			type: "maintenance",
			priority: "low",
			size: "xs",
			status: "done",
			created: "8d",
			labels: ["tooling"],
			moves: [
				{ ago: "7d1h", to: "in_progress", actor: "scheduler" },
				{ ago: "6d23h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "logging",
			title: "Structured request logging",
			priority: "medium",
			size: "m",
			status: "done",
			created: "8d",
			labels: ["observability"],
			owns: ["src/middleware/logging.ts"],
			body: "## Goal\n\nOne JSON log line per request with method, route, status, latency and the key\nid. Authorization headers must never be logged.\n",
			criteria: ["No secret ever appears in a log line"],
			moves: [
				{ ago: "6d6h", to: "in_progress", actor: "scheduler" },
				{
					ago: "6d5h",
					to: "ready",
					actor: "verifier",
					reason: "verification failed",
				},
				{ ago: "6d4h", to: "in_progress", actor: "brain" },
				{ ago: "6d3h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "zodcfg",
			title: "Validate configuration with zod at startup",
			priority: "low",
			size: "s",
			status: "draft",
			created: "2d",
			labels: ["dx"],
		},
		{
			alias: "cors",
			title: "CORS allow-list from configuration",
			priority: "low",
			size: "xs",
			status: "backlog",
			created: "6d",
			labels: ["api"],
		},
		{
			alias: "idem",
			title: "Idempotency keys on POST /keys",
			priority: "medium",
			size: "m",
			status: "backlog",
			created: "5d",
			labels: ["api"],
			body: "## Goal\n\nClients can retry `POST /keys` safely by sending `Idempotency-Key`.\n",
		},
		{
			alias: "refdoc",
			title: "Write the API reference introduction",
			priority: "low",
			size: "xs",
			status: "ready",
			created: "4d",
			labels: ["docs"],
			moves: [{ ago: "3d20h", to: "ready", actor: "scheduler" }],
		},
		{
			alias: "healthdeps",
			title: "Health endpoint: dependency checks",
			priority: "low",
			size: "s",
			status: "archived",
			created: "12d",
			labels: ["ops"],
			moves: [
				{ ago: "8d", to: "done", actor: "scheduler" },
				{ ago: "7d", to: "archived", actor: "human" },
			],
		},
	],
	groups: [
		{
			alias: "cursors",
			task: "cursors",
			status: "open",
			selection: "brain",
			start: "40m",
		},
	],
	runs: [
		{
			alias: "routerRun",
			task: "router",
			harness: "claude-cli",
			model: OPUS,
			effort: "high",
			start: "11d1h",
			minutes: 22,
			end: "merged",
			costUsd: 0.96,
			tokensIn: 288_000,
			tokensOut: 21_400,
			change: {
				message: "docs: record the router spike (Hono vs Fastify)",
				files: {
					"docs/spikes/router.md":
						"# Router spike: Hono vs Fastify\n\nBoth were driven with the same 1 KB JSON payload through the key-listing route.\n\n| | Hono | Fastify |\n|---|---|---|\n| req/s (1 core) | 41,200 | 39,800 |\n| p99 latency | 3.1 ms | 3.4 ms |\n| installed size | 0.4 MB | 2.1 MB |\n\nRecommendation: Hono. Same speed, a fraction of the weight, and middleware is\njust a function.\n",
				},
			},
			summary:
				"Benchmarked both routers against the key-listing route. Hono is level on throughput and a fifth of the install size; write-up in docs/spikes/router.md.",
			checks: [{ check: "files_exist docs/spikes/router.md", passed: true }],
		},
		{
			alias: "bucketRun",
			task: "bucket",
			harness: "claude-cli",
			model: SONNET,
			effort: "medium",
			start: "10d2h",
			minutes: 41,
			end: "merged",
			costUsd: 1.38,
			tokensIn: 412_000,
			tokensOut: 31_200,
			change: {
				message: "feat(limiter): token-bucket middleware",
				files: {
					"src/limiter/tokenBucket.ts":
						"export interface BucketConfig {\n\t/** Tokens the bucket holds when full. */\n\tburst: number;\n\t/** Tokens added per second. */\n\trefillPerSecond: number;\n}\n\nexport interface BucketState {\n\ttokens: number;\n\tupdatedAt: number;\n}\n\n/** Take one token; returns the new state and whether the request may pass. */\nexport function take(\n\tconfig: BucketConfig,\n\tstate: BucketState | undefined,\n\tnow: number,\n): { state: BucketState; allowed: boolean; retryAfterMs: number } {\n\tconst last = state ?? { tokens: config.burst, updatedAt: now };\n\tconst elapsed = Math.max(0, now - last.updatedAt) / 1000;\n\tconst tokens = Math.min(config.burst, last.tokens + elapsed * config.refillPerSecond);\n\tif (tokens >= 1) {\n\t\treturn { state: { tokens: tokens - 1, updatedAt: now }, allowed: true, retryAfterMs: 0 };\n\t}\n\tconst retryAfterMs = Math.ceil(((1 - tokens) / config.refillPerSecond) * 1000);\n\treturn { state: { tokens, updatedAt: now }, allowed: false, retryAfterMs };\n}\n",
					"src/middleware/rateLimit.ts":
						'import type { MiddlewareHandler } from "hono";\nimport { take } from "../limiter/tokenBucket.ts";\nimport type { QuotaStore } from "../store/quotaStore.ts";\n\nexport function rateLimit(store: QuotaStore, now = () => performance.now()): MiddlewareHandler {\n\treturn async (c, next) => {\n\t\tconst key = c.get("apiKey");\n\t\tconst config = await store.config(key);\n\t\tconst result = take(config, await store.state(key), now());\n\t\tawait store.save(key, result.state);\n\t\tif (!result.allowed) {\n\t\t\tc.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));\n\t\t\treturn c.json({ error: "rate_limited" }, 429);\n\t\t}\n\t\tawait next();\n\t};\n}\n',
					"test/tokenBucket.test.ts":
						'import { expect, test } from "bun:test";\nimport { take } from "../src/limiter/tokenBucket.ts";\n\nconst cfg = { burst: 3, refillPerSecond: 1 };\n\ntest("rejects once the burst is spent", () => {\n\tlet state;\n\tfor (let i = 0; i < 3; i++) state = take(cfg, state, 0).state;\n\tconst fourth = take(cfg, state, 0);\n\texpect(fourth.allowed).toBe(false);\n\texpect(fourth.retryAfterMs).toBe(1000);\n});\n\ntest("refills with the clock", () => {\n\tlet state = take(cfg, undefined, 0).state;\n\tstate = take(cfg, state, 0).state;\n\tstate = take(cfg, state, 0).state;\n\texpect(take(cfg, state, 2000).allowed).toBe(true);\n});\n',
				},
			},
			summary:
				"Added take() as a pure function and a Hono middleware around it. Retry-After is rounded up to whole seconds. Tests cover burst exhaustion and refill with a fake clock.",
			checks: [
				{ check: "typecheck", passed: true },
				{ check: "bun test", passed: true },
			],
		},
		{
			alias: "storeRun",
			task: "store",
			harness: "codex-cli",
			model: CODEX,
			effort: "high",
			start: "9d4h",
			minutes: 52,
			end: "merged",
			costUsd: 2.05,
			tokensIn: 530_000,
			tokensOut: 44_800,
			change: {
				message:
					"feat(store): QuotaStore interface and in-memory implementation",
				files: {
					"src/store/quotaStore.ts":
						'import type { BucketConfig, BucketState } from "../limiter/tokenBucket.ts";\n\nexport interface QuotaStore {\n\tconfig(key: string): Promise<BucketConfig>;\n\tstate(key: string): Promise<BucketState | undefined>;\n\tsave(key: string, state: BucketState): Promise<void>;\n\t/** Requests counted against the monthly quota. */\n\tusage(key: string): Promise<number>;\n\tincrement(key: string): Promise<number>;\n}\n\nexport const DEFAULT_BUCKET: BucketConfig = { burst: 20, refillPerSecond: 5 };\n',
					"src/store/memoryStore.ts":
						'import { type BucketConfig, type BucketState } from "../limiter/tokenBucket.ts";\nimport { DEFAULT_BUCKET, type QuotaStore } from "./quotaStore.ts";\n\nexport class MemoryStore implements QuotaStore {\n\tprivate configs = new Map<string, BucketConfig>();\n\tprivate states = new Map<string, BucketState>();\n\tprivate counters = new Map<string, number>();\n\n\tasync config(key: string) {\n\t\treturn this.configs.get(key) ?? DEFAULT_BUCKET;\n\t}\n\tasync state(key: string) {\n\t\treturn this.states.get(key);\n\t}\n\tasync save(key: string, state: BucketState) {\n\t\tthis.states.set(key, state);\n\t}\n\tasync usage(key: string) {\n\t\treturn this.counters.get(key) ?? 0;\n\t}\n\tasync increment(key: string) {\n\t\tconst next = (this.counters.get(key) ?? 0) + 1;\n\t\tthis.counters.set(key, next);\n\t\treturn next;\n\t}\n\tsetConfig(key: string, config: BucketConfig) {\n\t\tthis.configs.set(key, config);\n\t}\n}\n',
				},
			},
			summary:
				"Introduced the QuotaStore interface and an in-memory implementation; the middleware now depends on the interface only.",
			checks: [
				{ check: "typecheck", passed: true },
				{ check: "bun test", passed: true },
			],
		},
		{
			alias: "healthRun",
			task: "healthdeps",
			harness: "claude-cli",
			model: SONNET,
			start: "8d6h",
			minutes: 14,
			end: "merged",
			costUsd: 0.31,
			tokensIn: 98_000,
			tokensOut: 7_400,
			change: {
				message: "feat(health): report dependency status",
				files: {
					"src/routes/health.ts":
						'import { Hono } from "hono";\n\nexport const health = new Hono().get("/health", (c) =>\n\tc.json({ status: "ok", dependencies: { store: "memory" } }),\n);\n',
				},
			},
			summary: "The health route now reports the store backend.",
			checks: [{ check: "typecheck", passed: true }],
		},
		{
			alias: "bunRun",
			task: "bun",
			harness: "claude-cli",
			model: HAIKU,
			start: "7d",
			minutes: 9,
			end: "merged",
			costUsd: 0.12,
			tokensIn: 61_000,
			tokensOut: 3_900,
			change: {
				message: "chore: upgrade Bun to 1.3",
				files: {
					".bun-version": "1.3.0\n",
				},
			},
			summary: "Bumped the pinned version and ran the suite: green.",
			checks: [{ check: "bun test", passed: true }],
		},
		{
			alias: "logRun1",
			task: "logging",
			harness: "claude-cli",
			model: SONNET,
			start: "6d6h",
			minutes: 27,
			end: "failed",
			costUsd: 0.84,
			tokensIn: 301_000,
			tokensOut: 18_600,
			summary: "Logging middleware added, with the key id on every line.",
			checks: [
				{ check: "typecheck", passed: true },
				{
					check: "bun test",
					passed: false,
					detail:
						"logging.test.ts: expected the Authorization header to be redacted",
				},
			],
		},
		{
			alias: "logRun2",
			task: "logging",
			kind: "repair",
			relation: "repair",
			parent: "logRun1",
			harness: "claude-cli",
			model: SONNET,
			start: "6d4h",
			minutes: 11,
			end: "merged",
			costUsd: 0.37,
			tokensIn: 118_000,
			tokensOut: 8_100,
			change: {
				message: "feat(logging): structured request logging",
				files: {
					"src/middleware/logging.ts":
						'import type { MiddlewareHandler } from "hono";\n\nconst REDACTED = new Set(["authorization", "cookie", "x-api-key"]);\n\nexport function requestLogger(write: (line: string) => void = console.log): MiddlewareHandler {\n\treturn async (c, next) => {\n\t\tconst start = performance.now();\n\t\tawait next();\n\t\twrite(\n\t\t\tJSON.stringify({\n\t\t\t\tts: new Date().toISOString(),\n\t\t\t\tmethod: c.req.method,\n\t\t\t\troute: c.req.routePath,\n\t\t\t\tstatus: c.res.status,\n\t\t\t\tms: Math.round(performance.now() - start),\n\t\t\t\tkey: c.get("apiKeyId") ?? null,\n\t\t\t\theaders: Object.fromEntries(\n\t\t\t\t\t[...c.req.raw.headers].map(([k, v]) => [k, REDACTED.has(k) ? "[redacted]" : v]),\n\t\t\t\t),\n\t\t\t}),\n\t\t);\n\t};\n}\n',
				},
			},
			summary:
				"Redacted the Authorization, Cookie and X-Api-Key headers before logging; the test passes.",
			checks: [
				{ check: "typecheck", passed: true },
				{ check: "bun test", passed: true },
			],
		},
		{
			alias: "flakyRun",
			task: "flaky",
			harness: "claude-cli",
			model: SONNET,
			start: "2d3h",
			minutes: 31,
			end: "failed",
			costUsd: 0.92,
			tokensIn: 344_000,
			tokensOut: 16_700,
			summary:
				"Reproduced the flake locally: the session store test shares a Redis key namespace with the rate-limit test. A fix needs a Redis instance in CI, which this sandbox does not have.",
		},
		{
			alias: "adminRun",
			task: "admin",
			harness: "claude-cli",
			model: SONNET,
			effort: "medium",
			start: "1d3h",
			minutes: 47,
			end: "review",
			costUsd: 1.71,
			tokensIn: 486_000,
			tokensOut: 36_300,
			change: {
				message: "feat(admin): PATCH /admin/keys/:id/quota",
				files: {
					"src/routes/admin.ts":
						'import { Hono } from "hono";\nimport { z } from "zod";\nimport type { QuotaStore } from "../store/quotaStore.ts";\n\nconst Patch = z.object({\n\tburst: z.number().int().positive().max(10_000).optional(),\n\trefillPerSecond: z.number().positive().max(10_000).optional(),\n\tmonthlyQuota: z.number().int().positive().optional(),\n});\n\nexport function adminRoutes(store: QuotaStore & { setConfig(key: string, c: unknown): void }) {\n\treturn new Hono().patch("/admin/keys/:id/quota", async (c) => {\n\t\tif (c.get("role") !== "admin") return c.json({ error: "forbidden" }, 403);\n\t\tconst body = Patch.safeParse(await c.req.json());\n\t\tif (!body.success) return c.json({ error: "invalid_body", issues: body.error.issues }, 400);\n\t\tconst id = c.req.param("id");\n\t\tconst current = await store.config(id);\n\t\tstore.setConfig(id, { ...current, ...body.data });\n\t\tconsole.log(JSON.stringify({ audit: "quota.updated", actor: c.get("actor"), key: id, change: body.data }));\n\t\treturn c.json({ id, ...current, ...body.data });\n\t});\n}\n',
					"test/admin.test.ts":
						'import { expect, test } from "bun:test";\nimport { Hono } from "hono";\nimport { adminRoutes } from "../src/routes/admin.ts";\nimport { MemoryStore } from "../src/store/memoryStore.ts";\n\nfunction app(role: string) {\n\tconst store = new MemoryStore();\n\tconst a = new Hono();\n\ta.use("*", async (c, next) => {\n\t\tc.set("role", role);\n\t\tc.set("actor", "tester");\n\t\tawait next();\n\t});\n\ta.route("/", adminRoutes(store));\n\treturn { a, store };\n}\n\ntest("non-admins are refused", async () => {\n\tconst { a } = app("member");\n\tconst res = await a.request("/admin/keys/k1/quota", { method: "PATCH", body: "{}" });\n\texpect(res.status).toBe(403);\n});\n\ntest("an admin change applies to the next read", async () => {\n\tconst { a, store } = app("admin");\n\tawait a.request("/admin/keys/k1/quota", { method: "PATCH", body: JSON.stringify({ burst: 50 }) });\n\texpect((await store.config("k1")).burst).toBe(50);\n});\n',
				},
			},
			summary:
				"Added the PATCH route behind an admin-role check, validated with zod, and audit-logged every change with the actor. Two tests: 403 for members and an applied change.",
			checks: [
				{ check: "typecheck", passed: true },
				{ check: "bun test", passed: true },
				{ check: "files_exist src/routes/admin.ts", passed: true },
			],
		},
		{
			alias: "cursorA",
			task: "cursors",
			group: "cursors",
			relation: "attempt",
			role: "attempt",
			harness: "claude-cli",
			model: SONNET,
			effort: "medium",
			start: "38m",
			minutes: 24,
			end: "review",
			costUsd: 0.98,
			tokensIn: 322_000,
			tokensOut: 21_500,
			change: {
				message: "feat(keys): opaque base64url cursors",
				files: {
					"src/lib/cursor.ts":
						'export interface Cursor {\n\tafter: string;\n}\n\nexport function encodeCursor(c: Cursor): string {\n\treturn Buffer.from(JSON.stringify(c)).toString("base64url");\n}\n\nexport function decodeCursor(raw: string): Cursor | null {\n\ttry {\n\t\tconst v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));\n\t\treturn typeof v.after === "string" ? { after: v.after } : null;\n\t} catch {\n\t\treturn null;\n\t}\n}\n',
					"src/routes/keys.ts":
						'import { Hono } from "hono";\nimport { decodeCursor, encodeCursor } from "../lib/cursor.ts";\n\nexport function keyRoutes(list: (after: string | null, limit: number) => Promise<{ id: string }[]>) {\n\treturn new Hono().get("/keys", async (c) => {\n\t\tconst limit = Math.min(100, Number(c.req.query("limit") ?? 25));\n\t\tconst raw = c.req.query("cursor");\n\t\tconst cursor = raw ? decodeCursor(raw) : null;\n\t\tif (raw && !cursor) return c.json({ error: "invalid_cursor" }, 400);\n\t\tconst rows = await list(cursor?.after ?? null, limit + 1);\n\t\tconst page = rows.slice(0, limit);\n\t\tconst next = rows.length > limit ? encodeCursor({ after: page.at(-1)?.id ?? "" }) : null;\n\t\treturn c.json({ keys: page, next });\n\t});\n}\n',
				},
			},
			summary:
				"Cursors wrap the last seen key id in base64url JSON; listing fetches limit+1 rows to know whether another page exists.",
			checks: [
				{ check: "typecheck", passed: true },
				{ check: "bun test", passed: true },
			],
		},
		{
			alias: "cursorB",
			task: "cursors",
			group: "cursors",
			relation: "attempt",
			role: "attempt",
			harness: "codex-cli",
			model: CODEX,
			effort: "high",
			start: "36m",
			minutes: 34,
			end: "live",
			activity: "working",
			costUsd: 1.46,
			tokensIn: 410_000,
			tokensOut: 29_900,
			change: {
				message: "feat(keys): keyset pagination with signed cursors",
				files: {
					"src/lib/cursor.ts":
						'import { createHmac, timingSafeEqual } from "node:crypto";\n\nconst SECRET = process.env.CURSOR_SECRET ?? "dev-only-secret";\n\nfunction sign(payload: string): string {\n\treturn createHmac("sha256", SECRET).update(payload).digest("base64url").slice(0, 16);\n}\n\n/** `<after>.<mac>`: a client cannot forge a position in the listing. */\nexport function encodeCursor(after: string): string {\n\tconst payload = Buffer.from(after).toString("base64url");\n\treturn `${payload}.${sign(payload)}`;\n}\n\nexport function decodeCursor(raw: string): string | null {\n\tconst [payload, mac] = raw.split(".");\n\tif (!payload || !mac) return null;\n\tconst expected = Buffer.from(sign(payload));\n\tconst given = Buffer.from(mac);\n\tif (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;\n\treturn Buffer.from(payload, "base64url").toString("utf8");\n}\n',
					"src/routes/keys.ts":
						'import { Hono } from "hono";\nimport { decodeCursor, encodeCursor } from "../lib/cursor.ts";\n\nexport function keyRoutes(list: (after: string | null, limit: number) => Promise<{ id: string }[]>) {\n\treturn new Hono().get("/keys", async (c) => {\n\t\tconst limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25)));\n\t\tconst raw = c.req.query("cursor");\n\t\tconst after = raw ? decodeCursor(raw) : null;\n\t\tif (raw && after === null) return c.json({ error: "invalid_cursor" }, 400);\n\t\tconst rows = await list(after, limit + 1);\n\t\tconst page = rows.slice(0, limit);\n\t\treturn c.json({\n\t\t\tkeys: page,\n\t\t\tnext: rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]?.id ?? "") : null,\n\t\t});\n\t});\n}\n',
					"test/cursor.test.ts":
						'import { expect, test } from "bun:test";\nimport { decodeCursor, encodeCursor } from "../src/lib/cursor.ts";\n\ntest("round-trips", () => {\n\texpect(decodeCursor(encodeCursor("key_42"))).toBe("key_42");\n});\n\ntest("a tampered cursor is rejected", () => {\n\tconst c = encodeCursor("key_42");\n\texpect(decodeCursor(`${c}x`)).toBeNull();\n});\n',
				},
			},
			summary:
				"Signed the cursors with an HMAC so a client cannot invent a position, and added tests for round-trip and tampering.",
			checks: [
				{ check: "typecheck", passed: true },
				{ check: "bun test", passed: true },
			],
		},
		{
			alias: "webhooksRun0",
			task: "webhooks",
			harness: "claude-cli",
			model: OPUS,
			effort: "high",
			start: "3h",
			minutes: 7,
			end: "interrupted",
			costUsd: 0.22,
			tokensIn: 74_000,
			tokensOut: 4_100,
			summary:
				"Read the delivery code and drafted a backoff schedule before the daemon restarted.",
		},
		{
			alias: "webhooksRun",
			task: "webhooks",
			relation: "resume",
			parent: "webhooksRun0",
			harness: "claude-cli",
			model: OPUS,
			effort: "high",
			start: "38m",
			minutes: 31,
			end: "live",
			activity: "needs_answer",
			costUsd: 1.12,
			tokensIn: 366_000,
			tokensOut: 22_700,
			question: {
				text: "Should failed webhook deliveries retry on 4xx responses other than 408 and 429, or only on 5xx and network errors?",
				options: [
					"Only 5xx and network errors",
					"Also 408 and 429",
					"Every non-2xx response",
				],
			},
			subagents: [
				{
					type: "Explore",
					description: "Find every caller of deliverWebhook",
					tools: { Grep: 6, Read: 4 },
				},
			],
		},
		{
			alias: "headersRun",
			task: "headers",
			harness: "claude-cli",
			model: SONNET,
			effort: "medium",
			start: "34m",
			minutes: 34,
			end: "live",
			activity: "working",
			costUsd: 0.64,
			tokensIn: 221_000,
			tokensOut: 14_300,
			subagents: [
				{
					type: "Explore",
					description: "Where is the 429 response built?",
					tools: { Grep: 3, Read: 2 },
				},
			],
		},
	],
	brain: {
		model: OPUS,
		harness: "claude-cli",
		turns: [
			{
				ago: "11d",
				wake: "human",
				minutes: 6,
				costUsd: 0.74,
				actions: [
					{
						ago: "11d",
						tool: "set_plan",
						rationale:
							"First read of the board: an epic with a clear dependency chain.",
						text: "# Plan\n\n1. **Rate limiting epic** (limits): bucket, then store, then headers and admin in parallel.\n2. Keep one live run per task; the limiter is on the hot path, so review the admin endpoint myself.\n3. Park webhooks retries until the limiter lands: both touch the delivery middleware.\n\n## Watch\n- `owns` overlap between headers and admin: none today.\n- CI has no Redis, so anything touching the session store needs a human.\n",
					},
				],
			},
			{
				ago: "9d22h",
				wake: "settled",
				minutes: 3,
				costUsd: 0.31,
				actions: [
					{
						ago: "9d22h",
						tool: "spawn",
						task: "store",
						rationale:
							"bucket merged on the first pass; store is next in the chain and its dependency is done.",
						confidence: "high",
						args: { role: "implement", harness: "codex-cli", model: CODEX },
						alternatives: [
							{
								option: "run store and loadtest in parallel",
								why_not: "loadtest needs the store interface to exist",
							},
						],
					},
				],
			},
			{
				ago: "6d5h",
				wake: "settled",
				minutes: 4,
				costUsd: 0.42,
				actions: [
					{
						ago: "6d5h",
						tool: "spawn",
						task: "logging",
						run: "logRun1",
						rationale:
							"Verification failed on one redaction test only; a repair in the same worktree is cheaper than a restart.",
						confidence: "high",
						args: { role: "implement", worktree: "continue:logRun1" },
					},
				],
			},
			{
				ago: "2d",
				wake: "settled",
				minutes: 5,
				costUsd: 0.55,
				actions: [
					{
						ago: "2d",
						tool: "set_status",
						task: "flaky",
						rationale:
							"The agent reproduced the race but a fix needs Redis in CI. Another attempt would burn money and conclude the same.",
						confidence: "high",
						args: { to: "blocked", reason: "needs Redis in CI" },
					},
					{
						ago: "2d",
						tool: "notify_human",
						task: "flaky",
						rationale: "Only a person can grant CI access.",
						confidence: "high",
						args: {
							kind: "credential",
							title: "CI needs a Redis instance for the session-store test",
							body: "The flaky session-store test shares a Redis namespace with the rate-limit tests. I cannot verify a fix without a Redis service in CI. Once one exists, move the task back to ready and I will pick it up.",
							blocking: ["flaky"],
						},
					},
				],
			},
			{
				ago: "1d3h",
				wake: "frontier",
				minutes: 4,
				costUsd: 0.47,
				actions: [
					{
						ago: "1d3h",
						tool: "spawn",
						task: "admin",
						rationale:
							"store is merged and admin is unblocked; it touches only src/routes/admin.ts.",
						confidence: "high",
						args: { role: "implement", harness: "claude-cli", model: SONNET },
					},
					{
						ago: "1d3h",
						tool: "note",
						task: "admin",
						rationale: "Context for the reviewer.",
						text: "Admin endpoint changes quota state at runtime, so I marked it require_review: a person looks at the audit logging before it merges.",
					},
				],
			},
			{
				ago: "2h10m",
				wake: "settled",
				minutes: 3,
				costUsd: 0.36,
				actions: [
					{
						ago: "2h10m",
						tool: "request_review",
						task: "admin",
						run: "adminRun",
						rationale:
							"Verified, but the task requires a person; queue it with the diff and the audit-log note.",
						confidence: "high",
						status: "proposed",
						args: { mode: "agent" },
					},
				],
			},
			{
				ago: "40m",
				wake: "frontier",
				minutes: 5,
				costUsd: 0.58,
				actions: [
					{
						ago: "40m",
						tool: "spawn_attempts",
						task: "cursors",
						rationale:
							"Two defensible designs (opaque vs signed cursors) with different security properties. Cheaper to compare both than to guess.",
						confidence: "medium",
						args: {
							selection: "brain",
							variants: [
								{ harness: "claude-cli", model: SONNET },
								{ harness: "codex-cli", model: CODEX },
							],
						},
						alternatives: [
							{
								option: "one attempt with the simplest cursor",
								why_not:
									"the signed variant is the one a security review would ask for",
							},
						],
					},
				],
			},
			{
				ago: "30m",
				wake: "attention",
				minutes: 4,
				costUsd: 0.41,
				actions: [
					{
						ago: "30m",
						tool: "notify_human",
						task: "webhooks",
						rationale:
							"The run is blocked on a product decision I should not guess.",
						confidence: "high",
						args: {
							kind: "product_decision",
							title: "Webhook retry policy: which responses are retryable?",
							body: "The webhooks run asks whether 4xx responses other than 408 and 429 should be retried. Retrying every non-2xx hammers misconfigured receivers; retrying only 5xx drops deliveries to endpoints that return 404 during deploys. My recommendation is 5xx, network errors, 408 and 429.",
							blocking: ["webhooks"],
							options: [
								"5xx, network errors, 408 and 429",
								"Only 5xx and network errors",
								"Every non-2xx response",
							],
						},
					},
				],
			},
		],
	},
};

/** A docs site: kanban board in its own folder beside the repository. */
const northwind: SeedProject = {
	key: "northwind",
	name: "northwind-site",
	template: "kanban",
	separateBoard: true,
	repo: "northwind",
	tasks: [
		{
			alias: "gettingStarted",
			title: "Write the getting-started guide",
			priority: "high",
			status: "doing",
			created: "6d",
			labels: ["docs"],
			body: "## Goal\n\nA reader goes from `npm create` to a deployed site in ten minutes.\n",
			moves: [{ ago: "1h", to: "doing", actor: "scheduler" }],
		},
		{
			alias: "hero",
			title: "Redesign the landing hero",
			priority: "medium",
			status: "review",
			created: "5d",
			labels: ["design"],
			moves: [
				{ ago: "2d", to: "doing", actor: "scheduler" },
				{ ago: "20h", to: "review", actor: "verifier" },
			],
		},
		{
			alias: "search",
			title: "Add client-side search",
			priority: "medium",
			status: "todo",
			created: "5d",
			labels: ["feature"],
		},
		{
			alias: "links",
			title: "Fix broken links reported by the checker",
			type: "maintenance",
			priority: "low",
			status: "done",
			created: "7d",
			labels: ["quality"],
			moves: [
				{ ago: "5d", to: "doing", actor: "scheduler" },
				{ ago: "4d22h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "darkmode",
			title: "Dark mode for code blocks",
			priority: "low",
			status: "todo",
			created: "3d",
			labels: ["design"],
		},
		{
			alias: "sitemap",
			title: "Generate sitemap.xml at build time",
			priority: "low",
			status: "done",
			created: "7d",
			moves: [
				{ ago: "6d", to: "doing", actor: "scheduler" },
				{ ago: "5d20h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "redirects",
			title: "Redirect the old /docs/v1 paths",
			priority: "medium",
			status: "todo",
			dependsOn: ["links"],
			created: "3d",
			labels: ["seo"],
		},
	],
	runs: [
		{
			alias: "linksRun",
			task: "links",
			harness: "claude-cli",
			model: HAIKU,
			start: "5d",
			minutes: 12,
			end: "merged",
			costUsd: 0.09,
			tokensIn: 52_000,
			tokensOut: 3_100,
			change: {
				message: "docs: fix 14 broken internal links",
				files: {
					"content/guides/deploy.md":
						"# Deploying\n\nBuild with `npm run build` and upload `dist/`. See [configuration](/docs/configuration) for the base path.\n",
				},
			},
			summary: "Fixed 14 links; the checker is clean.",
			checks: [{ check: "link-check", passed: true }],
		},
		{
			alias: "sitemapRun",
			task: "sitemap",
			harness: "codex-cli",
			model: CODEX,
			start: "6d",
			minutes: 18,
			end: "merged",
			costUsd: 0.4,
			tokensIn: 133_000,
			tokensOut: 9_800,
			change: {
				message: "feat(build): generate sitemap.xml",
				files: {
					"scripts/sitemap.mjs":
						'import { readdirSync, writeFileSync } from "node:fs";\n\nconst pages = readdirSync("content", { recursive: true }).filter((f) => String(f).endsWith(".md"));\nconst urls = pages.map((p) => `  <url><loc>https://northwind.example/${String(p).replace(/\\.md$/, "")}</loc></url>`);\nwriteFileSync("dist/sitemap.xml", `<?xml version="1.0"?>\\n<urlset>\\n${urls.join("\\n")}\\n</urlset>\\n`);\n',
				},
			},
			summary: "A build step writes dist/sitemap.xml from the content tree.",
			checks: [{ check: "build", passed: true }],
		},
		{
			alias: "heroRun",
			task: "hero",
			harness: "claude-cli",
			model: SONNET,
			start: "2d",
			minutes: 36,
			end: "review",
			costUsd: 0.88,
			tokensIn: 280_000,
			tokensOut: 20_100,
			change: {
				message: "feat(landing): redesigned hero",
				files: {
					"src/components/Hero.astro":
						'---\nconst { title, tagline } = Astro.props;\n---\n<section class="hero">\n\t<h1>{title}</h1>\n\t<p>{tagline}</p>\n\t<a class="cta" href="/docs/getting-started">Get started</a>\n</section>\n<style>\n\t.hero { padding: 6rem 1.5rem; text-align: center; }\n\t.cta { display: inline-block; margin-top: 1.5rem; padding: .75rem 1.5rem; border-radius: .5rem; background: var(--accent); color: #fff; }\n</style>\n',
				},
			},
			summary:
				"Rebuilt the hero around one sentence and one button; screenshot attached to the task.",
			checks: [{ check: "build", passed: true }],
		},
		{
			alias: "guideRun",
			task: "gettingStarted",
			harness: "claude-cli",
			model: SONNET,
			start: "1h",
			minutes: 22,
			end: "interrupted",
			costUsd: 0.41,
			tokensIn: 150_000,
			tokensOut: 9_000,
		},
	],
};

/** A data pipeline: planning board, SQL models and a Python loader. */
const orders: SeedProject = {
	key: "orders",
	name: "orders-pipeline",
	template: "planning",
	repo: "orders",
	tasks: [
		{
			alias: "dedupe",
			title: "Deduplicate late-arriving order events",
			priority: "high",
			status: "doing",
			created: "5d",
			labels: ["quality"],
			body: "## Goal\n\nThe `orders_clean` model counts an order twice when its event arrives late.\nKey on `(order_id, version)` and keep the highest.\n",
			moves: [{ ago: "1d", to: "doing", actor: "scheduler" }],
		},
		{
			alias: "backfill",
			title: "Backfill 2025 orders into the warehouse",
			priority: "medium",
			status: "planned",
			dependsOn: ["dedupe"],
			created: "5d",
			labels: ["backfill"],
		},
		{
			alias: "freshness",
			title: "Add freshness checks to the staging models",
			priority: "medium",
			status: "done",
			created: "9d",
			labels: ["quality"],
			moves: [
				{ ago: "7d", to: "doing", actor: "scheduler" },
				{ ago: "6d20h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "partition",
			title: "Partition fact_orders by day",
			priority: "medium",
			status: "done",
			created: "9d",
			labels: ["performance"],
			moves: [
				{ ago: "6d", to: "doing", actor: "scheduler" },
				{ ago: "5d19h", to: "done", actor: "scheduler" },
			],
		},
		{
			alias: "currency",
			title: "Normalise currencies to EUR",
			priority: "low",
			status: "deferred",
			created: "8d",
			labels: ["finance"],
			blockedReason: "Waiting on the finance team's rate table.",
			moves: [{ ago: "4d", to: "deferred", actor: "human" }],
		},
		{
			alias: "docsModels",
			title: "Document the mart models",
			type: "maintenance",
			priority: "low",
			status: "planned",
			created: "4d",
			labels: ["docs"],
		},
		{
			alias: "cdc",
			title: "Spike: change-data-capture instead of nightly dumps",
			type: "spike",
			priority: "medium",
			status: "planned",
			created: "3d",
			labels: ["research"],
		},
	],
	runs: [
		{
			alias: "freshRun",
			task: "freshness",
			harness: "claude-cli",
			model: SONNET,
			start: "7d",
			minutes: 24,
			end: "merged",
			costUsd: 0.62,
			tokensIn: 211_000,
			tokensOut: 14_900,
			change: {
				message: "feat(models): freshness checks on staging",
				files: {
					"models/staging/_sources.yml":
						"version: 2\nsources:\n  - name: shop\n    loaded_at_field: _loaded_at\n    freshness:\n      warn_after: { count: 6, period: hour }\n      error_after: { count: 24, period: hour }\n    tables:\n      - name: orders\n      - name: order_items\n",
				},
			},
			summary:
				"Freshness thresholds on both source tables; dbt source freshness passes against the fixture.",
			checks: [{ check: "dbt parse", passed: true }],
		},
		{
			alias: "partRun",
			task: "partition",
			harness: "codex-cli",
			model: CODEX,
			start: "6d",
			minutes: 33,
			end: "merged",
			costUsd: 0.97,
			tokensIn: 260_000,
			tokensOut: 18_700,
			change: {
				message: "perf(marts): partition fact_orders by day",
				files: {
					"models/marts/fact_orders.sql":
						"{{ config(materialized='incremental', partition_by={'field': 'order_date', 'data_type': 'date'}) }}\n\nselect\n    order_id,\n    customer_id,\n    date(placed_at) as order_date,\n    total_cents\nfrom {{ ref('orders_clean') }}\n{% if is_incremental() %}\nwhere date(placed_at) >= date_sub(current_date(), interval 3 day)\n{% endif %}\n",
				},
			},
			summary:
				"fact_orders is incremental and partitioned by order_date; a full refresh costs a third as much.",
			checks: [{ check: "dbt parse", passed: true }],
		},
		{
			alias: "dedupeRun",
			task: "dedupe",
			harness: "claude-cli",
			model: SONNET,
			start: "26m",
			minutes: 26,
			end: "interrupted",
			costUsd: 0.47,
			tokensIn: 176_000,
			tokensOut: 11_300,
		},
	],
};

export const SEED_PLAN: SeedPlan = {
	// harbor is attached last: at boot each project's reconcile kills tmux sessions
	// it does not own, so only the last project's live runs survive.
	projects: [northwind, orders, harbor],
	usage: {
		subscriptions: [
			{
				provider: "claude-cli",
				name: "Claude Code",
				accountLabel: "max",
				windows: [
					{
						label: "5h",
						usedPercent: 62,
						resetsInMinutes: 133,
						windowMinutes: 300,
					},
					{
						label: "7d",
						usedPercent: 41,
						resetsInMinutes: 3_800,
						windowMinutes: 10_080,
					},
					{
						label: "7d Opus",
						usedPercent: 27,
						resetsInMinutes: 3_800,
						windowMinutes: 10_080,
					},
				],
			},
			{
				provider: "codex-cli",
				name: "Codex",
				accountLabel: "plus",
				windows: [
					{
						label: "5h",
						usedPercent: 18,
						resetsInMinutes: 212,
						windowMinutes: 300,
					},
					{
						label: "7d",
						usedPercent: 83,
						resetsInMinutes: 2_150,
						windowMinutes: 10_080,
					},
				],
			},
		],
	},
};
