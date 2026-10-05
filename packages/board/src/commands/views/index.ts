import type { CommandContext, ParsedArgs } from "../types.ts";
import { boardView } from "./board.ts";

/** A named `mfwb view <name>`; add a view = one file here + one line below. */
export interface View {
	name: string;
	usage: string;
	run(ctx: CommandContext, args: ParsedArgs): Promise<void>;
}

export const views: View[] = [boardView];
