// Runs `runForwarding` on the child argv given as arguments, then exits with
// its code. Bounded: a hard 10 s deadline ends this process (the fake child
// also ends itself after 8 s).
import { runForwarding } from "../../src/run-child.ts";

const argv = process.argv.slice(2);
const deadline = setTimeout(() => {
	console.error("forward-parent: deadline");
	process.exit(124);
}, 10_000);
const code = await runForwarding(argv);
clearTimeout(deadline);
console.log(`parent-exit ${code}`);
process.exit(code);
