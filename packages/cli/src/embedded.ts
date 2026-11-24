/**
 * What `tools/compile.ts` embeds into the compiled `mfw`, as the virtual module
 * `mfw:embedded`. Nothing here exists in a checkout.
 */

import type { HostContentId } from "../../daemon/src/containment/host-script.ts";
import type { EmbeddedMigrations } from "../../db/src/migration-source.ts";

export interface EmbeddedPayload {
	/** The project database's migrations and their manifest. */
	migrations: EmbeddedMigrations;
	/** Built scripts a sandbox runs, by id. */
	scripts: Record<HostContentId, string>;
	/** The libsql addon: its embedded file and the sha256 recorded at build. */
	libsql: { file: string; sha256: string };
	/** Named sha256 digests for `mfw version`. */
	integrity: Record<string, string>;
}
