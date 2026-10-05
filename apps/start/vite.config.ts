import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

/**
 * The app is served at https://<host>.ts.net/mfw/ by `tailscale serve`.
 *
 * Vite's `base` is the only place the prefix is configured:
 * `deriveRouterBasepath()` (@tanstack/start-plugin-core) falls back to it, so
 * `createRouter()` sets no basepath. Baked in at build time; everything else
 * reads `import.meta.env.BASE_URL`.
 */
const base = process.env.MFW_BASE_PATH ?? "/mfw/";

export default defineConfig({
	base,
	server: { port: 7777 },
	plugins: [
		tsConfigPaths({ projects: ["./tsconfig.json"] }),
		/**
		 * `baseURL` is not derived from Vite's `base` (which only rewrites HTML and
		 * manifest URLs); without it assets 404 (HTML asks for /mfw/assets/...,
		 * nitro serves /assets/...).
		 */
		nitro({
			baseURL: base,
			// Runs at server startup (dev and production); boots the orchestrator eagerly.
			plugins: ["./src/server/boot.ts"],
		}),
		tanstackStart(),
		viteReact(),
		tailwindcss(),
	],
});
