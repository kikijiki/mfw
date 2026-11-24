/** The payload `tools/compile.ts` embeds into the compiled `mfw` (see `embedded.ts`). */
declare module "mfw:embedded" {
	const payload: import("./embedded.ts").EmbeddedPayload;
	export default payload;
}
