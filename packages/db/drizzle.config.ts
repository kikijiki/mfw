import type { Config } from "drizzle-kit";

/**
 * drizzle-kit config (generate/push/studio). The runtime applies the schema via
 * `openDb()`; this is for migration tooling. DATABASE_URL is a libSQL URL.
 */
export default {
	schema: "./src/schema.ts",
	out: "./migrations",
	dialect: "sqlite",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "file:./mfw.db",
	},
} satisfies Config;
