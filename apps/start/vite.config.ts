import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { buildStampFor, stampDefine } from "../../tools/build-stamp.ts";

/**
 * The app is served at https://<host>.ts.net/mfw/ by `tailscale serve`.
 *
 * Vite's `base` is the only place the prefix is configured:
 * `deriveRouterBasepath()` (@tanstack/start-plugin-core) falls back to it, so
 * `createRouter()` sets no basepath. Baked in at build time; everything else
 * reads `import.meta.env.BASE_URL`.
 */
const base = process.env.MFW_BASE_PATH ?? "/mfw/";

export default defineConfig(({ command, isPreview }) => ({
	base,
	/**
	 * Only Vite's own dev server, which has its own bind, skips the start-up
	 * exposure check. NODE_ENV plays no part: every built bundle enforces it.
	 */
	define: {
		__MFW_VITE_DEV_SERVER__: JSON.stringify(
			command === "serve" && isPreview !== true,
		),
		/**
		 * A built bundle knows it is one from this constant, not from where it was
		 * copied to (`packages/core/src/build-info.ts`).
		 */
		...(command === "build"
			? stampDefine(
					buildStampFor(
						fileURLToPath(new URL("../..", import.meta.url)),
						"bundle",
					),
				)
			: {}),
	},
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
			// Run at server startup (dev and production): open the auth store and
			// print a first-run setup token, then boot the orchestrator eagerly.
			plugins: ["./src/server/auth-boot.ts", "./src/server/boot.ts"],
			errorHandler: "./src/server/error-handler.ts",
		}),
		tanstackStart(),
		viteReact(),
		tailwindcss(),
	],
}));
