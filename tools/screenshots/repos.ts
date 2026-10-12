// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are file contents of dummy repositories
/**
 * The dummy repositories' base history: what each project looked like before
 * mfw worked on it. Every commit is dated relative to the anchor instant (see
 * `plan.ts` `parseAgo`), so `git log` reads as a believable three weeks.
 */

export interface RepoCommit {
	/** Age before the anchor, e.g. "21d". */
	ago: string;
	author: string;
	message: string;
	/** Path to content; null deletes. */
	files: Record<string, string | null>;
}

const MARA = "Mara Lindqvist <mara@harbor.example>";
const JONAH = "Jonah Okafor <jonah@harbor.example>";
const TESS = "Tess Whitfield <tess@harbor.example>";

const harborBase: RepoCommit[] = [
	{
		ago: "21d",
		author: MARA,
		message: "chore: initial commit",
		files: {
			"README.md":
				"# harbor-api\n\nThe public HTTP API for Harbor: API keys, usage and webhooks.\n\n```sh\nbun install\nbun run dev      # http://localhost:3000\nbun test\n```\n\nSee [docs/architecture.md](docs/architecture.md) for how the pieces fit.\n",
			"package.json":
				'{\n\t"name": "harbor-api",\n\t"private": true,\n\t"type": "module",\n\t"scripts": {\n\t\t"dev": "bun --watch src/server.ts",\n\t\t"test": "bun test",\n\t\t"typecheck": "tsc --noEmit"\n\t},\n\t"dependencies": {\n\t\t"hono": "^4.6.0",\n\t\t"zod": "^3.23.0"\n\t},\n\t"devDependencies": {\n\t\t"@types/bun": "latest",\n\t\t"typescript": "^5.6.0"\n\t}\n}\n',
			"tsconfig.json":
				'{\n\t"compilerOptions": {\n\t\t"target": "ES2022",\n\t\t"module": "ESNext",\n\t\t"moduleResolution": "Bundler",\n\t\t"strict": true,\n\t\t"noEmit": true,\n\t\t"allowImportingTsExtensions": true,\n\t\t"types": ["bun"]\n\t},\n\t"include": ["src", "test"]\n}\n',
			".gitignore": "node_modules/\n.env\nworktrees/\n",
		},
	},
	{
		ago: "20d",
		author: MARA,
		message: "feat: server skeleton with health route",
		files: {
			"src/server.ts":
				'import { Hono } from "hono";\nimport { health } from "./routes/health.ts";\n\nconst app = new Hono();\napp.route("/", health);\n\nexport default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };\n',
			"src/routes/health.ts":
				'import { Hono } from "hono";\n\nexport const health = new Hono().get("/health", (c) => c.json({ status: "ok" }));\n',
			"test/health.test.ts":
				'import { expect, test } from "bun:test";\nimport { health } from "../src/routes/health.ts";\n\ntest("health is ok", async () => {\n\tconst res = await health.request("/health");\n\texpect(res.status).toBe(200);\n});\n',
		},
	},
	{
		ago: "19d",
		author: JONAH,
		message: "feat(keys): API key model and bearer auth",
		files: {
			"src/middleware/auth.ts":
				'import type { MiddlewareHandler } from "hono";\n\nexport interface ApiKey {\n\tid: string;\n\trole: "member" | "admin";\n}\n\nexport function bearerAuth(lookup: (token: string) => Promise<ApiKey | null>): MiddlewareHandler {\n\treturn async (c, next) => {\n\t\tconst header = c.req.header("authorization") ?? "";\n\t\tconst token = header.startsWith("Bearer ") ? header.slice(7) : "";\n\t\tconst key = token ? await lookup(token) : null;\n\t\tif (!key) return c.json({ error: "unauthorized" }, 401);\n\t\tc.set("apiKey", key.id);\n\t\tc.set("role", key.role);\n\t\tawait next();\n\t};\n}\n',
			"test/auth.test.ts":
				'import { expect, test } from "bun:test";\nimport { Hono } from "hono";\nimport { bearerAuth } from "../src/middleware/auth.ts";\n\nconst app = new Hono();\napp.use("*", bearerAuth(async (t) => (t === "good" ? { id: "k1", role: "member" } : null)));\napp.get("/", (c) => c.text("ok"));\n\ntest("rejects a missing token", async () => {\n\texpect((await app.request("/")).status).toBe(401);\n});\n\ntest("accepts a known token", async () => {\n\tconst res = await app.request("/", { headers: { authorization: "Bearer good" } });\n\texpect(res.status).toBe(200);\n});\n',
		},
	},
	{
		ago: "17d",
		author: TESS,
		message: "docs: architecture overview and API notes",
		files: {
			"docs/architecture.md":
				"# Architecture\n\nharbor-api is one Hono app. Requests pass through three layers:\n\n1. **Auth** (`src/middleware/auth.ts`): resolves a bearer token to an API key and a role.\n2. **Policy** (rate limiting, quotas): decides whether the request may proceed.\n3. **Routes** (`src/routes/*`): thin handlers over the key store.\n\nState lives behind interfaces so tests and single-node deployments use the\nin-memory implementations.\n\n## Deployment\n\nOne container per region behind the load balancer; no sticky sessions.\n",
			"docs/api.md":
				'# API\n\nAll endpoints expect `Authorization: Bearer <key>`.\n\n| Method | Path | Description |\n|---|---|---|\n| GET | /health | Liveness probe, unauthenticated |\n| GET | /keys | List keys visible to the caller |\n| POST | /keys | Create a key |\n| DELETE | /keys/:id | Revoke a key |\n\nErrors are JSON: `{ "error": "<code>" }`.\n',
		},
	},
	{
		ago: "15d",
		author: JONAH,
		message: "feat(keys): create and revoke keys",
		files: {
			"src/routes/keys.ts":
				'import { Hono } from "hono";\n\nexport function keyRoutes(db: Map<string, { id: string; label: string }>) {\n\treturn new Hono()\n\t\t.get("/keys", (c) => c.json({ keys: [...db.values()] }))\n\t\t.post("/keys", async (c) => {\n\t\t\tconst { label } = await c.req.json();\n\t\t\tconst id = `key_${crypto.randomUUID().slice(0, 8)}`;\n\t\t\tdb.set(id, { id, label: String(label) });\n\t\t\treturn c.json({ id }, 201);\n\t\t})\n\t\t.delete("/keys/:id", (c) => {\n\t\t\tdb.delete(c.req.param("id"));\n\t\t\treturn c.body(null, 204);\n\t\t});\n}\n',
		},
	},
	{
		ago: "14d",
		author: MARA,
		message: "docs: runbook for on-call",
		files: {
			"docs/runbook.md":
				"# Runbook\n\n## 5xx rate above 1%\n\n1. Check the dashboard for a single failing route.\n2. `kubectl rollout undo deployment/harbor-api` if the last deploy is under an hour old.\n3. Page the owning team from the on-call sheet.\n\n## Latency p99 above 250 ms\n\nUsually the key store. Check connection saturation before scaling the API.\n",
		},
	},
];

const northwindBase: RepoCommit[] = [
	{
		ago: "30d",
		author: TESS,
		message: "chore: scaffold the site",
		files: {
			"README.md":
				"# Northwind documentation site\n\nBuilt with Astro. Content lives in `content/`, one Markdown file per page.\n\n```sh\nnpm install\nnpm run dev\n```\n",
			"package.json":
				'{\n\t"name": "northwind-site",\n\t"private": true,\n\t"type": "module",\n\t"scripts": {\n\t\t"dev": "astro dev",\n\t\t"build": "astro build",\n\t\t"check:links": "node scripts/check-links.mjs"\n\t},\n\t"dependencies": {\n\t\t"astro": "^4.15.0"\n\t}\n}\n',
			".gitignore": "node_modules/\ndist/\nworktrees/\n",
			"astro.config.mjs":
				'import { defineConfig } from "astro/config";\n\nexport default defineConfig({ site: "https://northwind.example" });\n',
		},
	},
	{
		ago: "26d",
		author: TESS,
		message: "docs: first guides",
		files: {
			"content/index.md":
				"---\ntitle: Northwind\n---\n\nNorthwind is a small toolkit for shipping static sites.\n",
			"content/guides/configuration.md":
				"---\ntitle: Configuration\n---\n\nEverything is configured in `astro.config.mjs`. The two options you will touch are `site` and `base`.\n",
			"content/guides/deploy.md":
				"---\ntitle: Deploying\n---\n\nBuild with `npm run build` and upload `dist/`. See [configuration](/docs/config) for the base path.\n",
		},
	},
	{
		ago: "22d",
		author: JONAH,
		message: "feat: header, footer and navigation",
		files: {
			"src/layouts/Base.astro":
				'---\nconst { title } = Astro.props;\n---\n<html lang="en">\n\t<head><title>{title} · Northwind</title></head>\n\t<body>\n\t\t<header><a href="/">Northwind</a></header>\n\t\t<main><slot /></main>\n\t\t<footer>© Northwind</footer>\n\t</body>\n</html>\n',
		},
	},
	{
		ago: "12d",
		author: TESS,
		message: "ci: link checker on every pull request",
		files: {
			"scripts/check-links.mjs":
				'// Fails the build when an internal link points nowhere.\nimport { readdirSync, readFileSync } from "node:fs";\n\nconst pages = new Set(readdirSync("content", { recursive: true }).map(String));\nlet broken = 0;\nfor (const file of pages) {\n\tif (!file.endsWith(".md")) continue;\n\tconst text = readFileSync(`content/${file}`, "utf8");\n\tfor (const [, href] of text.matchAll(/\\]\\((\\/[^)#]+)\\)/g)) {\n\t\tif (!pages.has(`${href.slice(1)}.md`)) {\n\t\t\tconsole.error(`${file}: broken link ${href}`);\n\t\t\tbroken++;\n\t\t}\n\t}\n}\nprocess.exit(broken ? 1 : 0);\n',
		},
	},
];

const ordersBase: RepoCommit[] = [
	{
		ago: "28d",
		author: JONAH,
		message: "chore: dbt project skeleton",
		files: {
			"README.md":
				"# orders-pipeline\n\nNightly pipeline that loads shop orders into the warehouse and builds the\nreporting marts with dbt.\n\n```\nloader/    Python extractor (shop API -> bronze tables)\nmodels/    dbt models: staging -> marts\ndocs/      data dictionary and runbooks\n```\n",
			".gitignore": "target/\nlogs/\n.venv/\nworktrees/\n",
			"dbt_project.yml":
				"name: orders\nversion: '1.0.0'\nprofile: orders\nmodel-paths: ['models']\nmodels:\n  orders:\n    staging: { +materialized: view }\n    marts: { +materialized: table }\n",
		},
	},
	{
		ago: "24d",
		author: JONAH,
		message: "feat(loader): extract orders and items from the shop API",
		files: {
			"loader/extract.py":
				'"""Pull orders updated since the last watermark and write them as JSONL."""\nimport json\nimport sys\nfrom datetime import datetime, timezone\n\nimport requests\n\nAPI = "https://shop.example/api/v2"\n\n\ndef extract(since: str, out) -> int:\n    page, count = 1, 0\n    while True:\n        r = requests.get(f"{API}/orders", params={"updated_since": since, "page": page}, timeout=30)\n        r.raise_for_status()\n        rows = r.json()["orders"]\n        if not rows:\n            return count\n        for row in rows:\n            row["_loaded_at"] = datetime.now(timezone.utc).isoformat()\n            out.write(json.dumps(row) + "\\n")\n            count += 1\n        page += 1\n\n\nif __name__ == "__main__":\n    print(extract(sys.argv[1], sys.stdout), file=sys.stderr)\n',
			"loader/requirements.txt": "requests==2.32.3\n",
		},
	},
	{
		ago: "20d",
		author: TESS,
		message: "feat(models): staging and clean orders",
		files: {
			"models/staging/stg_orders.sql":
				"select\n    id as order_id,\n    customer_id,\n    status,\n    total_cents,\n    placed_at,\n    version,\n    _loaded_at\nfrom {{ source('shop', 'orders') }}\n",
			"models/staging/orders_clean.sql":
				"select *\nfrom {{ ref('stg_orders') }}\nwhere status != 'test'\n",
			"models/marts/fact_orders.sql":
				"select\n    order_id,\n    customer_id,\n    date(placed_at) as order_date,\n    total_cents\nfrom {{ ref('orders_clean') }}\n",
		},
	},
	{
		ago: "16d",
		author: JONAH,
		message: "docs: data dictionary",
		files: {
			"docs/data-dictionary.md":
				"# Data dictionary\n\n## fact_orders\n\nOne row per order version that survived cleaning.\n\n| column | meaning |\n|---|---|\n| order_id | Shop order id |\n| customer_id | Shop customer id |\n| order_date | Day the order was placed (UTC) |\n| total_cents | Order total in minor units |\n",
			"docs/runbook.md":
				"# Runbook\n\n## The nightly load failed\n\nRe-run `loader/extract.py` with the previous watermark; extraction is idempotent\non `(order_id, version)`.\n",
		},
	},
];

export const REPOS: Record<string, RepoCommit[]> = {
	harbor: harborBase,
	northwind: northwindBase,
	orders: ordersBase,
};
