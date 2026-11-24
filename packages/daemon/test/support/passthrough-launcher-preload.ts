import { join } from "node:path";
import { plugin } from "bun";

/** Points a bridge at the passthrough launcher. Loaded only by brain-turn test fixtures. */
const passthrough = join(import.meta.dir, "passthrough-launcher.ts");
plugin({
	name: "passthrough-launcher",
	setup(build) {
		build.onLoad({ filter: /agent-launch-argv\.ts$/ }, async (args) => {
			const text = await Bun.file(args.path).text();
			const target = "hostEntry(import.meta.url, AGENT_LAUNCHER)";
			if (!text.includes(target)) throw new Error("launcher path moved");
			return {
				loader: "ts",
				contents: text.replace(target, JSON.stringify(passthrough)),
			};
		});
	},
});
