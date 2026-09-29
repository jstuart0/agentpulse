// D40 (F251): AGENTPULSE_AI_ENABLED / AGENTPULSE_SECRETS_KEY safe defaults,
// factored out of __test_db.ts so bunfig.toml's [test] preload can set them
// before ANY test file's own imports run.
//
// src/server/config.ts computes `aiEnabled`/`secretsKey` (and every other
// field) once, into a plain object literal, at first import — and Bun
// shares one module registry across the whole `bun test` process. Whichever
// file happens to reach config.ts first (by Bun's module-graph load order,
// not necessarily file/describe declaration order — a discovery-order
// artifact, not something any individual test controls) permanently bakes
// in whatever env vars are set at that instant. __test_db.ts's own
// `??=` defaults only helped when a test file imported it before anything
// else reached config.ts; a file that never imports __test_db.ts (or that
// reaches config.ts transitively before its own imports run, e.g. via a
// dynamically-imported route module) could still freeze config with unsafe
// values. A preload guarantees these two defaults land first, regardless
// of load order — see .mozart/investigations/active/
// 2026-09-29-diagnose-f251-full-suite-pollution.md for the full root cause.
//
// __test_db.ts still owns SQLITE_PATH/DATA_DIR and the temp-path safety
// guard (those need the temp directory it creates, so they stay there) and
// imports this module rather than duplicating these two lines.
process.env.AGENTPULSE_AI_ENABLED ??= "true";
process.env.AGENTPULSE_SECRETS_KEY ??= "test-secrets-key-01234567890123456789";
