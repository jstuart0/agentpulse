/**
 * The updater's real dependencies, built from the process environment. The only environment variable that
 * changes what the updater does is `AGENTPULSE_UPDATER_REAL_SERVICES` (read by the service manager): the repo,
 * the trust keys, the manifest URL and the clock are constants here, never overridable from the environment.
 */
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchCapped } from "../shared/capped-fetch.js";
import { detectInstallKind, readInstallRecord } from "../shared/install-record.js";
import { bootTimeMs, processIdentity } from "../shared/process-identity.js";
import { CANONICAL_REPO_URL, MANIFEST_URL } from "../shared/release-feed.js";
import { RELEASE_KEYS } from "../shared/release-keys.js";
import { defaultRun } from "./exec.js";
import { createFileLog } from "./log.js";
import { updaterPaths } from "./paths.js";
import { createNoneManager, createServiceManager } from "./service-manager.js";
import { smokeBoot } from "./smoke.js";
import { DEFAULT_TIMING, type UpdaterDeps, defaultUsageBytes } from "./updater.js";

export function resolveHome(env: Record<string, string | undefined>): string {
	return env.HOME && env.HOME !== "" ? env.HOME : homedir();
}

function freeBytes(path: string): number | null {
	try {
		const info = statfsSync(path);
		return Number(info.bavail) * Number(info.bsize);
	} catch {
		return null;
	}
}

export function buildRealDeps(env: Record<string, string | undefined>): UpdaterDeps {
	const home = resolveHome(env);
	const record = readInstallRecord(home);
	const serviceManager = record
		? createServiceManager({
				service: record.service,
				components: record.components,
				home,
				env,
			})
		: createNoneManager();
	return {
		home,
		cwd: process.cwd(),
		env,
		platform: process.platform,
		pid: process.pid,
		now: Date.now,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		run: defaultRun,
		fetchText: fetchCapped,
		serviceManager,
		keys: RELEASE_KEYS,
		canonicalRepoUrl: CANONICAL_REPO_URL,
		manifestUrl: MANIFEST_URL,
		detectKind: detectInstallKind,
		identityOf: processIdentity,
		bootTimeMs,
		freeBytes,
		usageBytes: defaultUsageBytes,
		bunBin: process.execPath,
		smokeEntry: join("dist", "server", "index.js"),
		smokeBoot,
		log: createFileLog(updaterPaths(home).log, Date.now),
		timing: DEFAULT_TIMING,
	};
}
