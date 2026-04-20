// Shared test-DB helper. The real db/client module binds to config.sqlitePath
// at import time, so only the first test file to set SQLITE_PATH wins. This
// helper lets the AI test suite coordinate on a single temp DB and clean
// between tests rather than fighting over module state.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP = mkdtempSync(join(tmpdir(), "ap-ai-test-"));
process.env.SQLITE_PATH ??= join(TMP, "test.db");
process.env.DATA_DIR ??= TMP;
process.env.AGENTPULSE_AI_ENABLED ??= "true";
process.env.AGENTPULSE_SECRETS_KEY ??= "test-secrets-key-01234567890123456789";

export const TEST_TMP_DIR = TMP;
