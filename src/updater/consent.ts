/**
 * `agentpulse update auto on|off`: the only way automatic updates are turned on, and it happens on the machine
 * itself. Consent is `update-consent.json` under this account's `.agentpulse/`, private and owned by it; no
 * server route, API key, MCP tool or web control can write it (rules 4, 5 and 7).
 *
 * `auto on` refuses unless:
 *  - no agent-session marker is in the environment (a running Claude Code puts `CLAUDECODE` and friends in its
 *    children's environment, so an agent that runs this command is refused before anything is asked);
 *  - stdin and stdout are both a terminal, and the person types `enable` (or `allow migrations` when the
 *    consent also lets an update cross a SQLite migration);
 *  - the install is one the updater may update: a release-following checkout under a launchd or systemd
 *    service on macOS or Linux, not a container, a cluster or a fork.
 * The timer goes in through the service-manager port. If the timer can't be installed the consent is put back.
 * `auto off` needs no confirmation (it only takes a power away): it removes the timer and clears the consent.
 *
 * Stated residual: an agent that can drive a pty with a scrubbed environment, or that writes the file itself
 * as the same user, can still turn it on. Same-user code is outside what this guards.
 *
 * The terminal check and the prompt reader are one module-level value that only a test replaces
 * (`setConsentIoForTests`); no environment variable can stand in for a terminal.
 */
import { constants, accessSync, mkdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { readInstallRecord } from "../shared/install-record.js";
import { FORK_ENV_STRIP_EXACT } from "../shared/launch-env-policy.js";
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import { isCanonicalRepoUrl } from "../shared/release-feed.js";
import { UPDATE_WINDOW_PATTERN, readConsentDocument } from "../shared/update-files.js";
import type { UpdateOutcomeCode } from "../shared/update-status.js";
import { updaterPaths } from "./paths.js";
import type { UpdaterDeps } from "./updater.js";

export interface ConsentIo {
	isTty(): boolean;
	/** Asks one question and returns the line typed. */
	prompt(question: string): Promise<string>;
}

const realIo: ConsentIo = {
	isTty: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
	prompt: (question) =>
		new Promise((resolve) => {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			rl.question(question, (answer) => {
				rl.close();
				resolve(answer);
			});
			rl.once("close", () => resolve(""));
		}),
};

let io: ConsentIo = realIo;

/** Test only: replaces the terminal check and the prompt reader (null restores the real ones). */
export function setConsentIoForTests(next: ConsentIo | null): void {
	io = next ?? realIo;
}

/** Refusals that are about the command itself, not an update outcome. */
export type ConsentOnlyRefusal =
	| "not_a_terminal"
	| "agent_session"
	| "not_confirmed"
	| "bad_window"
	| "git_not_found"
	| "timer_failed"
	| "consent_unwritable";

export type ConsentRefusal = UpdateOutcomeCode | ConsentOnlyRefusal;
export type ConsentResult = { ok: true } | { ok: false; code: ConsentRefusal };

export const CONSENT_REFUSAL_COPY: Record<ConsentOnlyRefusal, string> = {
	not_a_terminal:
		"Run this yourself in a terminal. It asks you to type a word, and nothing else can answer for you.",
	agent_session:
		"This looks like it was started from inside an agent session, so it won't turn on automatic updates. Run it in your own terminal.",
	not_confirmed: "Nothing was changed. Automatic updates stay off.",
	bad_window: "The window must look like 02:00-04:30 (24-hour, local time) and can't be empty.",
	git_not_found:
		"git wasn't found on your PATH, and the scheduled updater needs it. Install git, then try again.",
	timer_failed: "The scheduled job couldn't be installed, so automatic updates stay off.",
	consent_unwritable:
		"The consent file couldn't be written safely. Check that ~/.agentpulse is yours and not a link.",
};

export interface AutoOnRequest {
	allowMigrations: boolean;
	/** `HH:MM-HH:MM` in local time, or null for any time. */
	window: string | null;
}

export function windowIsValid(window: string): boolean {
	if (!UPDATE_WINDOW_PATTERN.test(window)) return false;
	const [start, end] = window.split("-");
	return start !== end;
}

function agentMarkerPresent(env: Record<string, string | undefined>): boolean {
	const markers = new Set(FORK_ENV_STRIP_EXACT);
	return Object.entries(env).some(
		([name, value]) => value !== undefined && value !== "" && markers.has(name.toUpperCase()),
	);
}

function findOnPath(name: string, path: string): boolean {
	for (const dir of path.split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return true;
		} catch {
			// not in this directory
		}
	}
	return false;
}

/** The timer job's PATH: the Bun that runs the updater first, then the caller's own absolute directories, then the system's. */
export function timerPath(env: Record<string, string | undefined>, bunBin: string): string {
	const entries = [
		dirname(bunBin),
		...(env.PATH ?? "").split(delimiter),
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	];
	const clean = entries.filter((dir) => isAbsolute(dir) && !/[\0\n\r]/.test(dir));
	return [...new Set(clean)].join(delimiter);
}

/** Why this install can't be updated by itself, or null. The same gates `runUpdate` applies, so consent is never given for what would refuse anyway. */
async function installRefusal(deps: UpdaterDeps): Promise<UpdateOutcomeCode | null> {
	if (deps.platform === "win32") return "no_service_manager";
	const kind = deps.detectKind(deps.env, deps.cwd, deps.home);
	if (kind === "kubernetes") return "kubernetes";
	if (kind === "container") return "container";
	const record = readInstallRecord(deps.home);
	if (!record) return "no_install_record";
	if (record.service === "none") return "no_service_manager";
	if (record.track === "ref") return "tracking_ref";
	if (!isCanonicalRepoUrl(record.repoUrl, deps.canonicalRepoUrl)) return "fork_install";
	if ((await deps.serviceManager.preflight()) !== "ok") return "no_service_manager";
	return null;
}

function writeConsent(
	deps: UpdaterDeps,
	app: { on: boolean; allowMigrations: boolean; window: string | null },
): boolean {
	const paths = updaterPaths(deps.home);
	try {
		mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
		const existing = readConsentDocument(deps.home);
		// The relay's section is another writer's: kept exactly as found.
		const clients = existing && "clients" in existing ? { clients: existing.clients } : {};
		writePrivateFileAtomicNoFollow(
			paths.consent,
			`${JSON.stringify({ schema: 1, app, ...clients })}\n`,
		);
		return true;
	} catch {
		return false;
	}
}

function currentApp(deps: UpdaterDeps): {
	on: boolean;
	allowMigrations: boolean;
	window: string | null;
} {
	const raw = readConsentDocument(deps.home)?.app;
	if (typeof raw !== "object" || raw === null)
		return { on: false, allowMigrations: false, window: null };
	const app = raw as Record<string, unknown>;
	return {
		on: app.on === true,
		allowMigrations: app.allowMigrations === true,
		window: typeof app.window === "string" ? app.window : null,
	};
}

export async function enableAuto(
	deps: UpdaterDeps,
	request: AutoOnRequest,
	say: (line: string) => void,
): Promise<ConsentResult> {
	if (agentMarkerPresent(deps.env)) return { ok: false, code: "agent_session" };
	if (!io.isTty()) return { ok: false, code: "not_a_terminal" };
	if (request.window !== null && !windowIsValid(request.window)) {
		return { ok: false, code: "bad_window" };
	}
	const refusal = await installRefusal(deps);
	if (refusal) return { ok: false, code: refusal };
	const path = timerPath(deps.env, deps.bunBin);
	if (!findOnPath("git", path)) return { ok: false, code: "git_not_found" };

	say("Automatic updates let this machine install new signed AgentPulse releases by itself.");
	say(
		"It checks every six hours, only inside the window you set, and only updates to a release that",
	);
	say("passed signature checks and is at least a day old (security fixes skip the wait).");
	say(
		"It restarts the server, and the supervisor when no session is running, and puts the old copy",
	);
	say("back if the new one doesn't start. This consent is for this machine only.");
	if (request.window) say(`Window: ${request.window} (local time).`);
	if (request.allowMigrations) {
		say("Migrations are allowed: an update may change the SQLite database. A copy is taken first,");
		say("but going back afterwards loses what was written since.");
	}
	const word = request.allowMigrations ? "allow migrations" : "enable";
	const typed = (await io.prompt(`Type ${word} to continue: `)).trim();
	if (typed !== word) return { ok: false, code: "not_confirmed" };

	const previous = currentApp(deps);
	const next = { on: true, allowMigrations: request.allowMigrations, window: request.window };
	if (!writeConsent(deps, next)) return { ok: false, code: "consent_unwritable" };
	try {
		await deps.serviceManager.installTimer({
			bunBin: deps.bunBin,
			bundlePath: join(updaterPaths(deps.home).updaterCurrent, "updater.js"),
			home: deps.home,
			path,
		});
	} catch {
		writeConsent(deps, previous);
		return { ok: false, code: "timer_failed" };
	}
	return { ok: true };
}

export async function disableAuto(deps: UpdaterDeps): Promise<ConsentResult> {
	// The consent goes first: with it cleared, a run the timer starts meanwhile does nothing.
	if (!writeConsent(deps, { on: false, allowMigrations: false, window: null })) {
		return { ok: false, code: "consent_unwritable" };
	}
	try {
		await deps.serviceManager.removeTimer();
	} catch {
		return { ok: false, code: "timer_failed" };
	}
	return { ok: true };
}
