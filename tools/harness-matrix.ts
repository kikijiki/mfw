/**
 * Writes the generated harness matrix from the built-in manifests:
 *
 *   bun run harness:matrix
 *
 * `harness-matrix.test.ts` fails when the committed file is stale.
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	HARNESS_MATRIX_PATH,
	renderHarnessMatrix,
} from "../packages/plugin-api/src/harness-matrix.ts";
import { builtinHarnessRegistry } from "../packages/plugin-api/src/harness-registry.ts";

const target = join(resolve(import.meta.dir, ".."), HARNESS_MATRIX_PATH);
writeFileSync(target, renderHarnessMatrix(builtinHarnessRegistry().list()));
console.log(`wrote ${HARNESS_MATRIX_PATH}`);
