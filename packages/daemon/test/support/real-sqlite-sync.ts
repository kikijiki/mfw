import { afterAll, beforeAll } from "bun:test";

/**
 * For a describe block that asserts a store's FULL durability: the test
 * preload turns SQLite fsync off for speed, which would change what those
 * assertions see. Connections opened while this is on keep their real settings.
 */
export function useRealSqliteSync(): void {
	// The flag the preload keeps on globalThis; importing the preload itself
	// would run it a second time.
	const sqliteSync = (globalThis as { __mfwTestSqliteSync?: { off: boolean } })
		.__mfwTestSqliteSync;
	beforeAll(() => {
		if (sqliteSync) sqliteSync.off = false;
	});
	afterAll(() => {
		if (sqliteSync) sqliteSync.off = true;
	});
}
