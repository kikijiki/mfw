/** The per-run egress proxy process: `egress-proxy-main.ts <config.json>`. */

import { runEgressProxyProcess } from "./egress-proxy-process.ts";

const path = process.argv[2];
if (!path) {
	process.stderr.write("usage: egress-proxy-main <config.json>\n");
	process.exit(1);
}
runEgressProxyProcess(path).catch((err) => {
	process.stderr.write(`egress proxy: ${(err as Error).message}\n`);
	process.exit(1);
});
