/**
 * How to update a server, as fixed text templates: one per install kind, with the version inserted only after
 * it parses as a release version (rules 21, 22, 39). Kept apart from update-status.ts so the web bundle that
 * shows the badge doesn't carry the command text; only the lazy Settings page imports this.
 */
import type { InstallKind } from "./install-record.js";
import { parseReleaseVersion } from "./version.js";

/** One line of "how to update": text, then optionally a command to copy, then optionally more text. */
export interface UpdateCommandLine {
	before: string;
	command?: string;
	after?: string;
}

const LOCAL_COMMAND = "~/.agentpulse/bin/agentpulse update";
const COMPOSE_FILES = "-f docker-compose.yml -f docker-compose.image.yml";

/**
 * How to update a server of this kind to `latest`, or null when `latest` isn't a release version. Every
 * line is a fixed template; the version is the only inserted value.
 */
export function updateCommandFor(
	kind: InstallKind,
	latest: string,
	track: "release" | "ref" | null,
): UpdateCommandLine[] | null {
	if (!parseReleaseVersion(latest)) return null;
	switch (kind) {
		case "local":
			if (track === "ref") {
				return [
					{
						before:
							"This install follows a branch, so it isn't updated for you. Re-run the installer without --ref to follow releases.",
					},
				];
			}
			return [
				{ before: "Run this on the machine that runs the AgentPulse server." },
				{ before: "", command: LOCAL_COMMAND },
				{ before: "If that command isn't there, re-run install-local.sh on that machine." },
			];
		case "container":
			return [
				{
					before: "If you run the published image:",
					command: `docker pull ghcr.io/jstuart0/agentpulse:${latest}`,
					after: "then recreate the container.",
				},
				{
					before: "If you use docker-compose.image.yml:",
					command: `AGENTPULSE_TAG=${latest} docker compose ${COMPOSE_FILES} pull && AGENTPULSE_TAG=${latest} docker compose ${COMPOSE_FILES} up -d`,
				},
				{
					before: "If you build it yourself, from your agentpulse checkout:",
					command: `git checkout v${latest} && docker compose up -d --build`,
				},
			];
		case "kubernetes":
			return [{ before: `Set both images (agentpulse and agentpulse-backup) to tag ${latest}.` }];
		case "source":
			return [
				{
					before: "",
					command: `git fetch --tags && git checkout v${latest} && bun install --frozen-lockfile && bun run build`,
				},
				{
					before: "Restart the server. To get automatic updates, install with install-local.sh.",
				},
			];
	}
}
