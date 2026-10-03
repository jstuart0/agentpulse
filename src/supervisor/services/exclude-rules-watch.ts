/**
 * The supervisor's view of the user's exclude rules: parsed once, and again
 * only when the rules file (or the directory holding it) changes. Every
 * supervisor report asks for the current rules, so the steady-state cost is the
 * two stat calls of excludeRulesSignature and nothing else; the file is read
 * and parsed when that signature differs from the last one. A periodic rescan
 * also re-resolves the rules' directories, so a symlink created or retargeted
 * later keeps matching (the shell check resolves on every event).
 *
 * The invalid-rules marker is kept in step with the state, under the same
 * trusted-directory, no-follow rule as every other evaluator
 * (setInvalidMarker).
 */
import { userInfo } from "node:os";
import {
	type ExcludeProbeFs,
	type LoadExcludeRulesResult,
	excludeRulesSignature,
	homeMismatchWarning,
	loadExcludeRules,
	reresolveRules,
	setInvalidMarker,
} from "../../shared/exclude-rules.js";

/**
 * The account's home as the user database has it (HOME is not consulted: a service manager or a wrapper
 * may have changed it); undefined when the system has none. AGENTPULSE_TEST_SUPERVISOR_ACCOUNT_HOME
 * stands in for it in tests only (an empty value means none), so a test never makes the supervisor look
 * at the real account's directory.
 */
export function resolveAccountHome(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const forTests = env.AGENTPULSE_TEST_SUPERVISOR_ACCOUNT_HOME;
	if (forTests !== undefined) return forTests || undefined;
	try {
		return userInfo().homedir;
	} catch {
		return undefined;
	}
}

/**
 * Says once, in the supervisor's own log, when the user's rules sit under the account's home but this
 * process runs with another HOME (see homeMismatchWarning). Changes nothing else.
 */
export function warnIfHomeMismatch(
	home: string,
	accountHome: string | undefined,
	log: (line: string) => void,
): boolean {
	const warning = homeMismatchWarning(home, accountHome);
	if (!warning) return false;
	log(`[supervisor] ${warning}`);
	return true;
}

const NO_HOME_RULES: LoadExcludeRulesResult = {
	state: "invalid",
	rules: [],
	reason: "the home directory is unknown, so the rules file cannot be located",
};

export interface RulesWatch {
	/** The rules now: two stat calls, and a read only when the file changed. */
	current(): LoadExcludeRulesResult;
	/** Like current(), and also re-resolves the rules' directories against the filesystem as it is now. */
	rescan(): LoadExcludeRulesResult;
	/** How many times the signature was checked and the file was read, for tests that pin the cost. */
	counters(): { probes: number; loads: number };
}

export interface RulesWatchOptions {
	home: string;
	log?: (line: string) => void;
	/** Test seam: replaces the two stat calls that detect a change. */
	probeFs?: ExcludeProbeFs;
}

export function createRulesWatch(options: RulesWatchOptions): RulesWatch {
	const { home, log = () => {} } = options;
	let rules: LoadExcludeRulesResult = { state: "none", rules: [] };
	let signature: string | null = null;
	let probes = 0;
	let loads = 0;

	function refresh(): LoadExcludeRulesResult {
		probes++;
		const next = home ? excludeRulesSignature(home, options.probeFs) : "no-home";
		if (next === signature) return rules;
		signature = next;
		loads++;
		const wasInvalid = rules.state === "invalid";
		rules = home ? loadExcludeRules(home) : NO_HOME_RULES;
		if (home) setInvalidMarker(home, rules.state === "invalid");
		if (rules.state === "invalid") {
			log(
				`[supervisor] exclude rules invalid${rules.line !== undefined ? ` (line ${rules.line})` : ""}: this host's supervisor is sending nothing: its exclude file or its saved exclude state has an error`,
			);
		} else if (wasInvalid) {
			log("[supervisor] exclude rules are valid again; reporting resumes");
		}
		return rules;
	}

	return {
		current: refresh,
		rescan() {
			const now = refresh();
			if (now.state !== "ok" || !home) return now;
			const resolved = reresolveRules(now.rules, home);
			if (resolved.some((rule, i) => rule !== now.rules[i])) rules = { ...now, rules: resolved };
			return rules;
		},
		counters: () => ({ probes, loads }),
	};
}
