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
 * Stated residuals, per agent. Every agent that runs commands as this account (Claude Code, Codex, Copilot CLI,
 * OpenCode, anything else) can do what this account can, so none of this is a boundary:
 *  - the marker check (`agentSessionMarker`: Claude Code, Codex, OpenCode, Copilot and AgentPulse's own variables)
 *    only catches an agent that leaves its variables in the command's environment; one that scrubs them, or runs
 *    the command through a login shell that resets them, passes;
 *  - the typed phrase has a random part that changes every run, so a script that types a fixed word fails, but an
 *    agent that drives a pty reads it off the prompt like a person does;
 *  - an agent can write `update-consent.json` and install the timer itself with the permissions it already has;
 *  - a parent-process walk (is any ancestor an agent?) was considered and left out: it is bounded only by the
 *    process table the agent can also reshape (a double fork reparents to init), so it would add a refusal that
 *    looks stronger than it is.
 * What the guard does buy: a consent that needs a person at a keyboard in the ordinary case, and a refusal that
 * says why when an agent tries the obvious thing.
 *
 * The terminal check and the prompt reader are one module-level value that only a test replaces
 * (`setConsentIoForTests`); no environment variable can stand in for a terminal.
 */
import { randomBytes } from "node:crypto";
import { constants, accessSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { readInstallRecord } from "../shared/install-record.js";
import { agentSessionMarker } from "../shared/launch-env-policy.js";
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import { isCanonicalRepoUrl } from "../shared/release-feed.js";
import { UPDATE_WINDOW_PATTERN, readConsent, readConsentDocument } from "../shared/update-files.js";
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
/** `detail` is a variable name, never a value, so a person can see what to unset. */
export type ConsentResult = { ok: true } | { ok: false; code: ConsentRefusal; detail?: string };

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

/** The directory of the first executable `name` on `path` (absolute entries only), or null. */
function findOnPath(name: string, path: string): string | null {
	for (const dir of path.split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return dir;
		} catch {
			// not in this directory
		}
	}
	return null;
}

const SYSTEM_DIRS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
];

/**
 * The timer job's PATH: the directories of the Bun that runs the updater and of the git found on the caller's
 * PATH, then fixed system directories. Never the caller's whole PATH: a directory somebody else can write into
 * that happened to be on it would otherwise be on the path of a job that runs unattended.
 */
export function timerPath(bunBin: string, gitDir: string): string {
	const dirs = [dirname(bunBin), gitDir, ...SYSTEM_DIRS];
	return [...new Set(dirs.filter((dir) => isAbsolute(dir) && !/[\0\n\r:]/.test(dir)))].join(
		delimiter,
	);
}

/** A confirmation phrase with a random part that changes every run, so a fixed script can't type it. */
function confirmationPhrase(allowMigrations: boolean): string {
	const part = randomBytes(3).toString("hex");
	return `${allowMigrations ? "allow migrations" : "enable"} ${part}`;
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

/** Whether anything at all is at `path` (a link counts, whatever it points at). */
function consentFileExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (err) {
		return (err as { code?: string }).code !== "ENOENT";
	}
}

function writeConsent(
	deps: UpdaterDeps,
	app: { on: boolean; allowMigrations: boolean; window: string | null },
): boolean {
	const paths = updaterPaths(deps.home);
	try {
		mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
		const existing = readConsentDocument(deps.home);
		// A file that is there but isn't one this account can trust (a link, someone else's, linked twice) or isn't
		// a schema-1 document may hold the relay's section; writing a fresh file would drop it, so nothing is written.
		if (!existing && consentFileExists(paths.consent)) return false;
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

/** The consent file's bytes as they are now, or null when there is none to put back. */
function consentBytes(deps: UpdaterDeps): string | null {
	try {
		return readFileSync(updaterPaths(deps.home).consent, "utf-8");
	} catch {
		return null;
	}
}

/** Puts the consent file back exactly as it was: the same bytes, or no file. */
function restoreConsent(deps: UpdaterDeps, original: string | null): void {
	const path = updaterPaths(deps.home).consent;
	try {
		if (original === null) rmSync(path, { force: true });
		else writePrivateFileAtomicNoFollow(path, original);
	} catch {
		// nothing more can be done; the read-back below tells the person
	}
}

export async function enableAuto(
	deps: UpdaterDeps,
	request: AutoOnRequest,
	say: (line: string) => void,
): Promise<ConsentResult> {
	const marker = agentSessionMarker(deps.env);
	if (marker) return { ok: false, code: "agent_session", detail: marker };
	if (!io.isTty()) return { ok: false, code: "not_a_terminal" };
	if (request.window !== null && !windowIsValid(request.window)) {
		return { ok: false, code: "bad_window" };
	}
	const refusal = await installRefusal(deps);
	if (refusal) return { ok: false, code: refusal };
	const gitDir = findOnPath("git", deps.env.PATH ?? "");
	if (!gitDir) return { ok: false, code: "git_not_found" };
	const path = timerPath(deps.bunBin, gitDir);

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
	const phrase = confirmationPhrase(request.allowMigrations);
	const typed = (await io.prompt(`Type "${phrase}" to continue: `)).trim();
	if (typed !== phrase) return { ok: false, code: "not_confirmed" };

	const original = consentBytes(deps);
	const next = { on: true, allowMigrations: request.allowMigrations, window: request.window };
	if (!writeConsent(deps, next)) return { ok: false, code: "consent_unwritable" };
	// Read it back the way the updater will: a file the updater wouldn't believe (a directory others can write
	// into, a link) reads as off, and a timer over consent that reads as off would do nothing, quietly.
	const back = readConsent(deps.home);
	if (!back.on || back.allowMigrations !== next.allowMigrations || back.window !== next.window) {
		restoreConsent(deps, original);
		await deps.serviceManager.removeTimer().catch(() => {});
		return { ok: false, code: "consent_unwritable" };
	}
	try {
		await deps.serviceManager.installTimer({
			bunBin: deps.bunBin,
			bundlePath: join(updaterPaths(deps.home).updaterCurrent, "updater.js"),
			home: deps.home,
			path,
		});
	} catch {
		restoreConsent(deps, original);
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
