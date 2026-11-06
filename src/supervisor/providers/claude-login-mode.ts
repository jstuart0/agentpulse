/**
 * Which permission mode a takeover runs under, picked from the login Claude Code reports (AGEN-117 T4, D11).
 *
 * `restricted` ignores the person's own Claude settings (their allow rules, hooks and CLAUDE.md), which is
 * what makes every file change and command reach a card. It only works for a login measured to work under
 * it, so the host asks Claude which login applies, before any row N exists and before S is read:
 *
 *  1. A `restricted` probe: `initialize` only, in a fixed empty directory. If its `account` matches an entry
 *     of `KNOWN_RESTRICTED_LOGINS`, the mode is `restricted`.
 *  2. Else an `ask` probe. If it shows the no-login shape, there is nothing a fork could run on:
 *     `claude_not_logged_in`. Anything else it reports (an `apiKeyHelper`, a keychain login on a host where
 *     headless can use it, Bedrock, Vertex, a `tokenSource` nobody measured, a missing or malformed
 *     `account`) is mode `ask`.
 *
 * A probe never sends a user line, so it makes no model call and costs nothing whatever the login. Every
 * probe child is dead before `pickForkMode` returns. AgentPulse reads the label Claude reports
 * (`tokenSource`, `apiKeySource`) and never a credential: the token or key is in the supervisor's
 * environment because the person put it there, and the child inherits it.
 */
import { mkdirSync } from "node:fs";
import { forkChildEnv } from "../../shared/launch-env-policy.js";
import { CLAUDE_FORK_MODES, type ClaudeForkMode } from "../../shared/session-resume.js";
import { probeArgv } from "./claude-argv.js";
import { type ClaudeStopTimings, PROBE_STOP_TIMINGS, spawnClaude } from "./claude-process.js";
import type { RpcTimers } from "./codex-rpc.js";

/** The three keys of `account` that login matching reads. Absent and `null` are the same. */
export type AccountProjection = {
	apiProvider: string | null;
	tokenSource: string | null;
	apiKeySource: string | null;
};

/**
 * Logins measured to work under `--restricted`: each has a committed fixture with this `account` and a real
 * (non-`<synthetic>`) reply, which `claude-login-mode.test.ts` holds by set equality. A new value Claude
 * reports goes to `ask`, never here. The `CLAUDE_CODE_OAUTH_TOKEN` entry
 * (`{apiProvider:"firstParty", tokenSource:"CLAUDE_CODE_OAUTH_TOKEN", apiKeySource:null}`) lands in the
 * commit that carries its fixture, not before: the one token run kept no raw lines (P0 `oauth_fixtures`).
 */
export const KNOWN_RESTRICTED_LOGINS: readonly AccountProjection[] = [
	{ apiProvider: "firstParty", tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" },
];

const INVALID = "\u0000invalid";

function labelOf(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	// A value that is not a string can equal no entry.
	return typeof value === "string" ? value : INVALID;
}

/** The three keys of `account`, or null when `account` is not an object. Other keys are never read. */
export function projectAccount(account: unknown): AccountProjection | null {
	if (!account || typeof account !== "object" || Array.isArray(account)) return null;
	const record = account as Record<string, unknown>;
	return {
		apiProvider: labelOf(record.apiProvider),
		tokenSource: labelOf(record.tokenSource),
		apiKeySource: labelOf(record.apiKeySource),
	};
}

export function matchesLogin(account: unknown, entry: AccountProjection): boolean {
	const projection = projectAccount(account);
	return (
		projection !== null &&
		projection.apiProvider === entry.apiProvider &&
		projection.tokenSource === entry.tokenSource &&
		projection.apiKeySource === entry.apiKeySource
	);
}

export function matchesKnownRestrictedLogin(account: unknown): boolean {
	return KNOWN_RESTRICTED_LOGINS.some((entry) => matchesLogin(account, entry));
}

/** `firstParty`, `tokenSource:"none"`, no `apiKeySource`: what `initialize` answers when nothing can log in. */
export function isNoLoginShape(account: unknown): boolean {
	return matchesLogin(account, {
		apiProvider: "firstParty",
		tokenSource: "none",
		apiKeySource: null,
	});
}

/**
 * Whether a child's own `initialize` account agrees with the mode the probes picked. Under `restricted` it
 * must be a known restricted login; under `ask` it must not be the no-login shape, and any other value (a
 * missing, null or malformed `account` included) passes: there the check only saves a person a wasted
 * prompt, the first prompt's `api_error` still catches a false pass, and a false refusal would lock out a
 * working login.
 */
export function accountAgreesWithMode(account: unknown, mode: ClaudeForkMode): boolean {
	if (!CLAUDE_FORK_MODES.includes(mode)) return false;
	return mode === "restricted" ? matchesKnownRestrictedLogin(account) : !isNoLoginShape(account);
}

export type ProbeResult =
	| { ok: true; account: unknown }
	| { ok: false; why: "timeout" | "spawn" | "initialize" };

export type LoginProbe = (mode: ClaudeForkMode) => Promise<ProbeResult>;

export type LoginModeChoice =
	| { mode: ClaudeForkMode; probes: number }
	| { refusal: "claude_not_logged_in" | "rejected"; probes: number };

/** Picks the mode from the probes. Pure over the probe runner, so every login shape is a fixture. */
export async function pickForkMode(probe: LoginProbe): Promise<LoginModeChoice> {
	const restricted = await probe("restricted");
	if (!restricted.ok) return { refusal: "rejected", probes: 1 };
	if (matchesKnownRestrictedLogin(restricted.account)) return { mode: "restricted", probes: 1 };
	const ask = await probe("ask");
	if (!ask.ok) return { refusal: "rejected", probes: 2 };
	if (isNoLoginShape(ask.account)) return { refusal: "claude_not_logged_in", probes: 2 };
	return { mode: "ask", probes: 2 };
}

/** The time one probe may take. Measured worst case is 0.9 s; the rest is a slow `apiKeyHelper`. */
export const LOGIN_PROBE_TIMEOUT_MS = 15_000;

/** How long a probe waits, after the stop ladder, for its child's exit to be seen. */
export const PROBE_EXIT_WAIT_MS = 5_000;

export type LoginProbeDeps = {
	/** Test seam as a parameter: how long to wait for the child's exit after the ladder. */
	exitWaitMs?: number;
	/** The process starter; a test hands one whose child never exits. */
	spawn?: typeof spawnClaude;
	executable: string;
	/** The supervisor's environment: the probe's is derived from it exactly as the fork's is. */
	env: Readonly<Record<string, string | undefined>>;
	/** A fixed, empty, private directory under the supervisor's state dir; never S's. Created if absent. */
	probeCwd: string;
	timeoutMs?: number;
	timers?: RpcTimers;
	timings?: ClaudeStopTimings;
	log?: (line: string) => void;
};

/**
 * Runs one probe: starts Claude with the mode's argv minus the conversation flags, sends `initialize`, reads
 * `account`, and ends the child before returning. No user line is ever written: the link is only asked to
 * initialize.
 */
export function createLoginProbe(deps: LoginProbeDeps): LoginProbe {
	const log = deps.log ?? ((line: string) => console.warn(line));
	return async (mode) => {
		let child: Awaited<ReturnType<typeof spawnClaude>>;
		try {
			mkdirSync(deps.probeCwd, { recursive: true, mode: 0o700 });
			child = await (deps.spawn ?? spawnClaude)({
				executable: deps.executable,
				args: probeArgv({ mode }),
				cwd: deps.probeCwd,
				env: forkChildEnv(deps.env),
				link: {
					timers: deps.timers,
					controlTimeoutMs: deps.timeoutMs ?? LOGIN_PROBE_TIMEOUT_MS,
				},
				timings: deps.timings ?? PROBE_STOP_TIMINGS,
			});
		} catch {
			log(`[claude-login] the ${mode} probe could not be started`);
			return { ok: false, why: "spawn" };
		}
		try {
			const answer = await child.link.initialize();
			const account =
				answer && typeof answer === "object"
					? (answer as { account?: unknown }).account
					: undefined;
			return { ok: true, account };
		} catch (error) {
			const timedOut = error instanceof Error && /no answer in time/.test(error.message);
			log(`[claude-login] the ${mode} probe ${timedOut ? "timed out" : "did not initialize"}`);
			return { ok: false, why: timedOut ? "timeout" : "initialize" };
		} finally {
			await child.stop();
			// Bounded: a child the ladder could not end must not hang the takeover that is waiting on its probe.
			const exited = await Promise.race([
				child.exited.then(() => true),
				new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => resolve(false), deps.exitWaitMs ?? PROBE_EXIT_WAIT_MS);
					timer.unref?.();
				}),
			]);
			if (!exited) log(`[claude-login] the ${mode} probe's process did not exit when asked`);
		}
	};
}

/** Logged once per takeover: the label Claude reported, never a value. */
export function describeLoginForLog(account: unknown): string {
	const projection = projectAccount(account);
	if (!projection) return "no account reported";
	const safe = (value: string | null) =>
		value === null ? "none" : /^[A-Za-z_]{1,40}$/.test(value) ? value : "other";
	return `provider=${safe(projection.apiProvider)} tokenSource=${safe(projection.tokenSource)} apiKeySource=${safe(projection.apiKeySource)}`;
}
