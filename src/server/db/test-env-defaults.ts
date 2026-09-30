import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AGENTPULSE_AI_ENABLED / AGENTPULSE_SECRETS_KEY safe defaults, factored
// out of __test_db.ts so bunfig.toml's [test] preload can set them before
// ANY test file's own imports run.
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
// of load order.
//
// __test_db.ts still owns SQLITE_PATH/DATA_DIR and the temp-path safety
// guard (those need the temp directory it creates, so they stay there) and
// imports this module rather than duplicating these two lines.
process.env.AGENTPULSE_AI_ENABLED ??= "true";
process.env.AGENTPULSE_SECRETS_KEY ??= "test-secrets-key-01234567890123456789";

// ── Home-directory sandbox (test-isolation incident, 2026-09-30) ──────────
//
// A test suite that computes a path from the developer's real home
// directory — directly (os.homedir(), $HOME) or through a resolved
// external binary (the real `claude`/`codex` CLI on PATH, which reads its
// own config from $HOME/$CODEX_HOME/$CLAUDE_CONFIG_DIR) — can read or write
// files in ~/.agentpulse, ~/.codex, ~/.claude, ~/.zshrc, etc. This has
// already happened once: a supervisor.json write, a `.zshrc` append, and a
// `~/.agentpulse/env` create all landed in a real developer home from a
// test run that never overrode $HOME for the code path it exercised. This
// preload closes the gap structurally, for every test file, rather than
// depending on each test remembering its own override:
//
// 1. Redirects every home-derived env var to a fresh, per-process temp
//    directory before any test file's own imports run.
// 2. Patches node:os's homedir() and Bun.spawn's/Bun.spawnSync's default
//    env (see the two "Finding" comments below) so code that reads the
//    real home through either of those two paths is redirected too — a
//    test file's own `process.env.HOME = tmpDir` override is not, by
//    itself, enough for either.
//
// A test that needs a SPECIFIC temp directory (e.g. to assert on file
// content at a known path) still creates and manages its own via
// `mkdtemp`/`mkdtempSync` and passes it explicitly — this sandbox only
// stops the *unintentional* fallback to the real machine home; it is not a
// replacement for a test's own fixture directory.
export const TEST_HOME_SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "ap-test-home-"));

// Recorded for the guard test (test-home-sandbox.test.ts) and for any
// diagnostic that wants to prove the override actually took effect — never
// mutated after this module's first evaluation.
export const ORIGINAL_HOME_ENV = Object.freeze({
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	CODEX_HOME: process.env.CODEX_HOME,
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
});

// HOME/USERPROFILE: every AgentPulse code path that resolves the home
// directory reads one of these two (platform-gated) rather than
// os.homedir() directly, precisely because of Finding #1 below —
// src/supervisor/config.ts's resolveHomeDir() is the reference
// implementation. Setting both, on every platform, means a test never has
// to know which one the code under test happens to read.
process.env.HOME = TEST_HOME_SANDBOX_ROOT;
process.env.USERPROFILE = TEST_HOME_SANDBOX_ROOT;
// XDG_CONFIG_HOME/XDG_DATA_HOME/CLAUDE_CONFIG_DIR: not read by any
// AgentPulse code today (grepped at the time this was written), but real
// external binaries invoked during tests (the actual installed
// `claude`/`codex` CLI — see Finding #2 below) honor these, so they're
// sandboxed too, defensively, rather than waiting for the next incident to
// name them.
process.env.XDG_CONFIG_HOME = join(TEST_HOME_SANDBOX_ROOT, ".config");
process.env.XDG_DATA_HOME = join(TEST_HOME_SANDBOX_ROOT, ".local", "share");
process.env.CODEX_HOME = join(TEST_HOME_SANDBOX_ROOT, ".codex");
process.env.CLAUDE_CONFIG_DIR = join(TEST_HOME_SANDBOX_ROOT, ".claude");

// Finding #1 (empirically verified against Bun 1.3.12): Bun's os.homedir()
// resolves the home directory once (at process start or first call —
// observed behavior, not documented contract) and does NOT track a
// process.env.HOME/USERPROFILE mutation made afterward, unlike Node's own
// os.homedir(), which re-reads the environment on every call. This is why
// src/supervisor/config.ts added its own resolveHomeDir() (AGEN-21) instead
// of trusting os.homedir() — but every OTHER call site in this codebase
// that still calls os.homedir() directly (config.ts's own
// buildDefaultConfig() default, claude-interactive.ts, codex-observer.ts,
// prelaunch-actions.ts) is exposed to exactly this gap during tests. Rather
// than auditing and fixing every present and future call site individually,
// mock.module replaces node:os process-wide for the rest of this
// `bun test` process — every caller of homedir(), including ones not yet
// written, gets the sandboxed value, read live off process.env on every
// call (matching Node's actual contract, which is what callers reasonably
// assume).
const realOs = await import("node:os");
mock.module("node:os", () => ({
	...realOs,
	homedir: () => {
		const envHome = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
		return envHome || realOs.homedir();
	},
}));

// Finding #2 (empirically verified, same session): Bun.spawn/
// Bun.spawnSync, when called with no explicit `env` option, do NOT inherit
// a live view of process.env — they use a snapshot resolved from the
// process's own OS-level startup environment, frozen before this (or any)
// preload ever runs. A test that overrides process.env.HOME and then
// triggers a code path that spawns a subprocess with no explicit `env`
// (src/supervisor/config.ts's captureExecutableVersion is the confirmed
// case: it resolves and shells out to the real, PATH-installed
// `claude`/`codex` binary whenever a config under test leaves
// claudeCommand/codexCommand unset) gets the developer's REAL ambient
// environment in that child process, silently, regardless of any
// process.env mutation made in-process. Reproduced: running the full suite
// with $HOME pointed at a decoy directory still left a real `codex` CLI
// scratch directory (~/.codex/tmp/arg0/…) under that decoy — proving the
// subprocess used the decoy (this preload's target), not whatever the test
// file's own beforeEach thought it had set, unless this same sandboxing is
// active for the child. Patching both entry points so a caller who didn't
// pass `env` gets an explicit, live `{...process.env}` closes this for
// every present and future call site the same way the os.homedir() patch
// above does — a test that spawns a subprocess with its own explicit
// `env: { HOME: someTempDir }` (the pattern most of this suite's
// installer/CLI tests already use) is untouched by this patch; it only
// fills in the gap for callers that pass no `env` at all.
type AnyFn = (...args: unknown[]) => unknown;

// Untyped by design: Bun.spawn/Bun.spawnSync are heavily overloaded
// (cmdArray+options vs. a single optionsObject with cmd/cmds inside), and
// this wrapper only needs to find and mutate the options bag generically,
// not reproduce the overload set. The `as unknown as typeof Bun.spawn`
// casts at the two assignment sites below are what keep every real call
// site fully typed against Bun's actual signatures.
function withLiveEnvDefault(fn: AnyFn): AnyFn {
	return (...args: unknown[]) => {
		const [first, second] = args;
		if (Array.isArray(first)) {
			// Bun.spawn(cmdArray, options?)
			const options = (second ?? {}) as Record<string, unknown>;
			if (!("env" in options)) options.env = { ...process.env };
			return fn(first, options);
		}
		if (first && typeof first === "object") {
			// Bun.spawn(optionsObject) — cmd/cmds live inside the object.
			const options = first as Record<string, unknown>;
			if (!("env" in options)) options.env = { ...process.env };
			return fn(options);
		}
		return fn(...args);
	};
}

Bun.spawn = withLiveEnvDefault(Bun.spawn as AnyFn) as unknown as typeof Bun.spawn;
Bun.spawnSync = withLiveEnvDefault(Bun.spawnSync as AnyFn) as unknown as typeof Bun.spawnSync;
