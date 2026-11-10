/**
 * The child process of sqlite-migration-ledger-boot.test.ts: boots the database the way index.ts does
 * (initializeDatabase, a MigrationLedgerError ends the process cleanly with exit 1 and its message) against
 * the file named by SQLITE_PATH. AGENTPULSE_LEGACY_INIT and the working directory (which picks the migrations
 * folder) come from the parent. Not a test file.
 */
export {};

const { initializeDatabase } = await import("../db/client.js");
const { MigrationLedgerError } = await import("../db/sqlite-migration-ledger.js");

try {
	await initializeDatabase();
} catch (err) {
	if (err instanceof MigrationLedgerError) {
		console.error(`[boot] ${err.message}`);
		process.exit(1);
	}
	throw err;
}
process.exit(0);
