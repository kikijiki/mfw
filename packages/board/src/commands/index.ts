import { check } from "./check.ts";
import { claim, release } from "./claim.ts";
import { conflicts } from "./conflicts.ts";
import { create } from "./create.ts";
import { graph } from "./graph.ts";
import { levels } from "./levels.ts";
import { list } from "./list.ts";
import { append, insert, move, prepend, remove } from "./list-ops.ts";
import { note } from "./note.ts";
import { plan } from "./plan.ts";
import { ready } from "./ready.ts";
import { repair } from "./repair.ts";
import { reparent } from "./reparent.ts";
import { row } from "./row.ts";
import { dec, inc, toggle, unset } from "./scalar-ops.ts";
import { show } from "./show.ts";
import { skill } from "./skill.ts";
import type { Command } from "./types.ts";
import { update } from "./update.ts";
import { validate } from "./validate.ts";
import { view } from "./view.ts";

/** The command registry. Adding a command = one new file + one line here. */
export const commands: Command[] = [
	list,
	show,
	create,
	update,
	claim,
	release,
	validate,
	skill,
	ready,
	levels,
	view,
	graph,
	plan,
	conflicts,
	reparent,
	repair,
	append,
	prepend,
	insert,
	remove,
	move,
	inc,
	dec,
	toggle,
	unset,
	check,
	note,
	row,
];

export * from "./types.ts";
