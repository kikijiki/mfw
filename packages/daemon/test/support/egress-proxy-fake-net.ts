import net from "node:net";
import { runEgressProxyProcess } from "../../src/containment/egress-proxy-process.ts";

/**
 * The real proxy process on a fake network: every name resolves to a label
 * address that is never dialed, and every upstream connection lands on the
 * given loopback port. `egress-proxy-fake-net.ts <config.json> <port>`.
 */
const [config, port] = process.argv.slice(2);
await runEgressProxyProcess(config as string, {
	resolve: async () => ["1.1.1.1"],
	localAddresses: () => [],
	connect: () => net.connect(Number(port), "127.0.0.1"),
});
