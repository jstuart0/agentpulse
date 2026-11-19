import type { UpdateOutcomeCode } from "../shared/update-status.js";
import { parseReleaseVersion } from "../shared/version.js";
/**
 * `agentpulse update`: the updater's command line. The shim (`~/.agentpulse/bin/agentpulse`) runs the bundled
 * copy of this file for every `update …` subcommand, with `AGENTPULSE_UPDATER_REAL_SERVICES=1`.
 *
 *   update [--to vX.Y.Z] [--allow-downgrade] [--wait]   move to the latest (or a named) release
 *   update rollback                                      go back to the previous copy
 *   update status                                        what this machine knows about updates
 *
 * `--auto` is what the scheduled job passes; it applies the consent and window checks. A person can't
 * start an update from the server, the web or MCP: this file is the only way in (a guard test holds that).
 */
import { OUTCOME_COPY } from "../web/lib/update-outcome-copy.js";
import { buildRealDeps } from "./real-deps.js";
import {
	type UpdateOptions,
	type UpdateResult,
	type UpdaterDeps,
	runRollback,
	runUpdate,
	updaterStatus,
} from "./updater.js";

export interface CliIo {
	out: (line: string) => void;
	err: (line: string) => void;
}

const USAGE = [
	"Usage: agentpulse update [--to vX.Y.Z] [--allow-downgrade] [--wait]",
	"       agentpulse update rollback",
	"       agentpulse update status",
];

export type ParsedArgs =
	| { kind: "update"; options: UpdateOptions }
	| { kind: "rollback" }
	| { kind: "status" }
	| { kind: "auto_consent" }
	| { kind: "usage"; message: string };

export function parseArgs(argv: string[]): ParsedArgs {
	const args = argv[0] === "update" ? argv.slice(1) : argv;
	const first = args[0];
	if (first === "rollback")
		return args.length === 1
			? { kind: "rollback" }
			: { kind: "usage", message: "rollback takes no arguments" };
	if (first === "status")
		return args.length === 1
			? { kind: "status" }
			: { kind: "usage", message: "status takes no arguments" };
	if (first === "auto") return { kind: "auto_consent" };
	const options: UpdateOptions = { mode: "manual" };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--allow-downgrade") options.allowDowngrade = true;
		else if (arg === "--wait") options.wait = true;
		else if (arg === "--auto") options.mode = "auto";
		else if (arg === "--to") {
			const value = args[++i];
			if (value === undefined) return { kind: "usage", message: "--to needs a version" };
			const version = value.startsWith("v") ? value.slice(1) : value;
			if (!parseReleaseVersion(version))
				return { kind: "usage", message: "--to needs a version like v0.12.0" };
			options.to = version;
		} else {
			return { kind: "usage", message: `unknown argument ${JSON.stringify(arg.slice(0, 40))}` };
		}
	}
	return { kind: "update", options };
}

const SUCCESS: readonly UpdateOutcomeCode[] = ["updated", "up_to_date"];

function printResult(result: UpdateResult, io: CliIo, rollbackCommand: boolean): void {
	const copy = OUTCOME_COPY[result.code] ?? {
		sentence: "The updater reported something unexpected.",
		next: "",
	};
	const versions = result.from && result.to ? ` (${result.from} to ${result.to})` : "";
	io.out(`${copy.sentence}${versions}`);
	if (copy.next) io.out(copy.next);
	if (result.reason) io.out(`Why: ${OUTCOME_COPY[result.reason]?.sentence ?? result.reason}`);
	if (result.code === "rolled_back") {
		io.out(
			"Anything the server was sent while the update ran (hook events, for one) was not recorded.",
		);
	}
	if (result.code === "rollback_failed") {
		io.out("Services are stopped. Nothing was started on a copy that might be damaged.");
		if (result.snapshotPath) {
			io.out(`The database copy taken before the update is at ${result.snapshotPath}.`);
			io.out("Restore it over the database file yourself, then start the services.");
		}
	}
	if (result.code === "updated" && result.migrated) {
		io.out(
			"This update changed the database. `agentpulse update rollback` restores the copy taken before it",
		);
		io.out("and loses anything written since.");
	}
	void rollbackCommand;
}

/** Runs the command and returns the process exit code. `deps` is for tests; the shim never passes it. */
export async function runCli(argv: string[], io: CliIo, deps?: UpdaterDeps): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.kind === "usage") {
		io.err(`${parsed.message}`);
		for (const line of USAGE) io.err(line);
		return 2;
	}
	if (parsed.kind === "auto_consent") {
		io.err("Automatic updates aren't available in this build yet.");
		return 2;
	}
	let real: UpdaterDeps;
	try {
		real = deps ?? buildRealDeps(process.env);
	} catch {
		io.err(
			"Run this through ~/.agentpulse/bin/agentpulse so the updater can reach your service manager.",
		);
		return 2;
	}
	if (parsed.kind === "status") {
		const status = updaterStatus(real);
		io.out(`Installed: ${status.installed ?? "unknown"}`);
		io.out(
			`Follows: ${status.track === "release" ? "releases" : status.track === "ref" ? "a branch" : "unknown"}`,
		);
		io.out(`Automatic updates: ${status.autoOn ? "on" : "off"}`);
		if (status.lastOutcome) {
			const copy = OUTCOME_COPY[status.lastOutcome];
			io.out(
				`Last run: ${copy?.sentence ?? status.lastOutcome}${status.at ? ` (${status.at})` : ""}`,
			);
		}
		if (status.refused.length > 0) io.out(`Not tried again: ${status.refused.join(", ")}`);
		if (status.journalPhase && !["done", "rolled_back"].includes(status.journalPhase)) {
			io.out(
				`An update didn't finish (${status.journalPhase}); the next run puts the install back first.`,
			);
		}
		io.out(`Previous copy kept: ${status.hasPrevious ? "yes" : "no"}`);
		io.out("Client scripts (relay, statusline, exclude check) are refreshed only by the relay.");
		io.out("On a machine with no relay they are not refreshed here: re-run setup after updating.");
		return 0;
	}
	const result =
		parsed.kind === "rollback" ? await runRollback(real) : await runUpdate(real, parsed.options);
	printResult(result, io, parsed.kind === "rollback");
	const ok =
		parsed.kind === "rollback" ? result.code === "rolled_back" : SUCCESS.includes(result.code);
	return ok ? 0 : 1;
}

if (import.meta.main) {
	runCli(process.argv.slice(2), { out: console.log, err: console.error }).then(
		(code) => process.exit(code),
		() => {
			console.error("The updater stopped unexpectedly. Run `agentpulse update status`.");
			process.exit(1);
		},
	);
}
