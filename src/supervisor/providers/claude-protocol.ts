/**
 * The protocol gate for a Claude Code takeover (AGEN-117 T3), stage one: whether this binary, on this
 * platform, reaching this server, is one the takeover was measured against. Claude Code publishes no
 * schema to hash, so the version range is the gate: a floor (the measured 2.1.318), an exclusive ceiling,
 * and a one-line blocked list. The canary per release and the first-prompt assertions are the rest.
 * Stage two (what the process itself reports in `initialize` and `init`) is `claude-stream.ts`.
 *
 * A reason is a fixed code, never text that came from the binary.
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSupervisorConfig } from "../config.js";
import { credentialRejectionMayConfirm } from "../services/report-resilience.js";
import type { Verdict } from "./codex-protocol.js";
import { type Version, compareVersions, parseVersion, versionInRange } from "./version-range.js";

/** Oldest Claude Code a takeover runs against (the measured version). */
export const CLAUDE_VERSION_FLOOR: Version = [2, 1, 318];
/** First version NOT measured: the range is `[floor, ceiling)`. */
export const CLAUDE_VERSION_CEILING: Version = [2, 2, 0];
/** The range as the dialog prints it. */
export const CLAUDE_VERSION_RANGE_TEXT = "2.1.318 up to, not including, 2.2.0";
/** Versions known to misbehave whatever the range says. One line to add to. */
export const BLOCKED_CLAUDE_VERSIONS: readonly string[] = [];

export const CLAUDE_VERSION_TIMEOUT_MS = 5_000;

export type ClaudeBinary = {
	path: string;
	version: string | null;
	size: number | null;
	mtimeMs: number | null;
};

export type ClaudeVerdictDeps = {
	platform?: NodeJS.Platform;
	blockedVersions?: readonly string[];
};

const identityKey = (b: { path: string; size: number | null; mtimeMs: number | null }) =>
	`${b.path}|${b.size}|${b.mtimeMs}`;

/** The version a binary prints, per identity; a failure is never remembered. */
const versionCache = new Map<string, Promise<string | null>>();

export function _resetClaudeVersionCacheForTest(): void {
	versionCache.clear();
}

/**
 * `claude --version` under a throwaway `HOME` and config dir, with a bare environment: nothing of the
 * person's is read or written by asking, and a hook or helper in their settings can't run. Null when it
 * can't be had.
 */
export async function readClaudeVersion(
	path: string,
	options: { timeoutMs?: number } = {},
): Promise<string | null> {
	const root = await mkdtemp(join(tmpdir(), "agentpulse-claude-version-"));
	try {
		const home = join(root, "home");
		await mkdir(home);
		const proc = Bun.spawn({
			cmd: [path, "--version"],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				CLAUDE_CONFIG_DIR: join(home, ".claude"),
				DISABLE_AUTOUPDATER: "1",
			},
		});
		const timer = setTimeout(
			() => proc.kill("SIGKILL"),
			options.timeoutMs ?? CLAUDE_VERSION_TIMEOUT_MS,
		);
		try {
			const [stdout, code] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				proc.exited,
			]);
			if (code !== 0) return null;
			const token = stdout.split("\n")[0]?.trim().split(/\s+/)[0] ?? "";
			return parseVersion(token) ? token : null;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/**
 * The executable, its version and the server URL, read once from the supervisor's config. The probes, the
 * fork and the verdict all use this, so they can't disagree about which binary they mean.
 */
export async function resolveClaude(): Promise<{ binary: ClaudeBinary; serverUrl: string }> {
	const config = await loadSupervisorConfig();
	const entry = config.capabilities.executables?.claude;
	const path = entry?.resolvedPath || config.claudeCommand || "claude";
	let size: number | null = null;
	let mtimeMs: number | null = null;
	try {
		const info = await stat(path);
		size = info.size;
		mtimeMs = info.mtimeMs;
	} catch {
		// A bare command name or a missing file: the identity just has no size.
	}
	const key = identityKey({ path, size, mtimeMs });
	let reading = versionCache.get(key);
	if (!reading) {
		reading = readClaudeVersion(path);
		versionCache.set(key, reading);
	}
	const version = await reading;
	if (version === null) versionCache.delete(key);
	return { binary: { path, version, size, mtimeMs }, serverUrl: config.serverUrl };
}

/** Never throws. */
export function claudeProtocolVerdict(
	binary: ClaudeBinary,
	serverUrl: string | undefined,
	deps: ClaudeVerdictDeps = {},
): Verdict {
	if ((deps.platform ?? process.platform) !== "darwin") {
		return { verdict: "unsupported", reason: "unsupported_platform" };
	}
	if (!credentialRejectionMayConfirm(serverUrl)) {
		return { verdict: "insecure_transport", reason: "plain_http" };
	}
	const version = parseVersion(binary.version);
	if (!version) return { verdict: "unsupported", reason: "version_unknown" };
	if (!versionInRange(version, CLAUDE_VERSION_FLOOR, CLAUDE_VERSION_CEILING)) {
		const below = compareVersions(version, CLAUDE_VERSION_FLOOR) < 0;
		return { verdict: "unsupported", reason: below ? "below_floor" : "above_range" };
	}
	if (
		binary.version &&
		(deps.blockedVersions ?? BLOCKED_CLAUDE_VERSIONS).includes(binary.version)
	) {
		return { verdict: "unsupported", reason: "blocked_version" };
	}
	return { verdict: "supported", reason: "ok" };
}
