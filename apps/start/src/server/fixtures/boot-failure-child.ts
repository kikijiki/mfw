import { installOrchestrator } from "../boot.ts";

delete process.env.MFW_SERVE_UI_ONLY;
installOrchestrator(
	{
		hooks: {
			hook() {},
		},
	},
	async () => {
		throw new Error("fatal eager boot failure");
	},
);

// Without the production fatal handler this models the server listener keeping
// the process alive indefinitely after the rejected eager boot.
setInterval(() => {}, 60_000);
