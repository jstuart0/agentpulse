/**
 * What `agentpulse version` prints: the app version, how this machine was installed, and the versions of
 * the client files copied onto it (the relay and the statusline). Read-only and display-only: nothing here
 * decides whether to update, so a copy's version is read as plain text and anything that isn't a release
 * version is reported as unknown, never echoed.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type InstallKind, detectInstallKind, readInstallRecord } from "./install-record.js";
import { parseReleaseVersion } from "./version.js";

const MAX_COPY_BYTES = 2 * 1024 * 1024;
/** The first release that carries a version constant in these files. */
const FIRST_VERSIONED_RELEASE = "0.11.0";

const RELAY_VERSION_LINE = /^export const RELAY_VERSION = "([^"\n]{1,64})";$/m;
const STATUSLINE_VERSION_LINE = /^AGENTPULSE_STATUSLINE_VERSION="([^"\n]{1,64})"$/m;

type CopyVersion =
	| { state: "absent" }
	| { state: "unknown" }
	| { state: "version"; version: string };

function readCopy(path: string, line: RegExp): CopyVersion {
	let text: string;
	try {
		const st = lstatSync(path);
		if (!st.isFile() || st.size > MAX_COPY_BYTES) return { state: "unknown" };
		text = readFileSync(path, "utf-8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { state: "absent" }
			: { state: "unknown" };
	}
	const token = line.exec(text)?.[1];
	return token && parseReleaseVersion(token)
		? { state: "version", version: token }
		: { state: "unknown" };
}

function describeCopy(label: string, copy: CopyVersion): string {
	if (copy.state === "absent") return `  ${label}: not installed`;
	if (copy.state === "unknown") {
		return `  ${label}: unknown version (older than ${FIRST_VERSIONED_RELEASE})`;
	}
	return `  ${label}: ${copy.version}`;
}

export interface VersionReportInput {
	appVersion: string;
	home: string;
	/** The checkout this CLI runs from. An install record names the install by this directory. */
	checkoutDir: string;
	env: Record<string, string | undefined>;
}

export function buildVersionReport(input: VersionReportInput): string[] {
	const { appVersion, home, checkoutDir, env } = input;
	const kind: InstallKind = detectInstallKind(env, checkoutDir, home);
	const record = kind === "local" ? readInstallRecord(home) : null;
	const lines = [`AgentPulse ${appVersion}`];
	lines.push(
		record
			? `  Install: local (tracking ${record.track === "release" ? "releases" : `ref ${record.ref}`})`
			: `  Install: ${kind}`,
	);
	const relay = readCopy(join(home, ".agentpulse", "relay.ts"), RELAY_VERSION_LINE);
	const statusline = readCopy(
		join(home, ".claude", "statusline-agentpulse.sh"),
		STATUSLINE_VERSION_LINE,
	);
	lines.push(describeCopy("Relay", relay), describeCopy("Statusline", statusline));
	if (relay.state === "absent" && statusline.state !== "absent") {
		lines.push(
			"  The statusline is not refreshed here: no relay on this machine; re-run setup after updating.",
		);
	}
	return lines;
}
