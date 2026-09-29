// Shared test-DB helper. The real db/client module binds to config.sqlitePath
// at import time, so only the first test file to set SQLITE_PATH wins. This
// helper lets the AI test suite coordinate on a single temp DB and clean
// between tests rather than fighting over module state.

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "ap-ai-test-"));
process.env.SQLITE_PATH ??= join(TMP, "test.db");

// tessa F119: tests wipe tables freely, so an exported SQLITE_PATH pointing at
// a real database must never be used. Accept only paths under the OS temp dir
// (compared both as given and resolved through symlinks, e.g. macOS /var).
{
	const tempRoots = [resolve(tmpdir()), realpathSync(tmpdir())];
	const effective = resolve(process.env.SQLITE_PATH);
	if (
		!tempRoots.some((root) => effective.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
	) {
		throw new Error(
			`[__test_db] refusing SQLITE_PATH=${effective}: tests only run against a database under ${tempRoots[0]}. Unset SQLITE_PATH to use a temp database.`,
		);
	}
}
process.env.DATA_DIR ??= TMP;
process.env.AGENTPULSE_AI_ENABLED ??= "true";
process.env.AGENTPULSE_SECRETS_KEY ??= "test-secrets-key-01234567890123456789";

export const TEST_TMP_DIR = TMP;
