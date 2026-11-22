/**
 * For a test that asserts a store's FULL durability: the test preload turns
 * SQLite fsync off for speed, which would change what that assertion sees.
 * Connections opened inside `fn` keep the store's real settings.
 */
export async function withRealSqliteSync<T>(fn: () => Promise<T>): Promise<T> {
	// The flag the preload keeps on globalThis; importing the preload itself
	// would run it a second time.
	const sqliteSync = (globalThis as { __mfwTestSqliteSync?: { off: boolean } })
		.__mfwTestSqliteSync;
	const was = sqliteSync?.off ?? false;
	if (sqliteSync) sqliteSync.off = false;
	try {
		return await fn();
	} finally {
		if (sqliteSync) sqliteSync.off = was;
	}
}
