import { constants, accessSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { arch, homedir, hostname, platform } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
	tightenPrivateFilePermissionsSync,
	writePrivateFileSyncNoFollow,
} from "../shared/private-file.js";
import type { SupervisorRegistrationInput } from "../shared/types.js";

export interface SupervisorConfig {
	serverUrl: string;
	apiKey?: string;
	supervisorCredential?: string;
	enrollmentToken?: string;
	id?: string;
	hostName: string;
	platform: string;
	arch: string;
	version: string;
	trustedRoots: string[];
	capabilities: SupervisorRegistrationInput["capabilities"];
	claudeCommand?: string;
	codexCommand?: string;
	terminalPreference?: string;
}

// AGEN-21: reads process.env.HOME/USERPROFILE directly rather than
// os.homedir() — Bun's os.homedir() resolves the home directory once and
// does not track a process.env.HOME/USERPROFILE override made afterward
// (Node's does), which is exactly what tests need to point this at a temp
// dir instead of the real ~/.agentpulse/supervisor.json. Falls back to
// os.homedir() when the platform's env var isn't set, matching Node's own
// documented os.homedir() behavior.
function resolveHomeDir(): string {
	const envHome = platform() === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return envHome || homedir();
}

// A function rather than a module-level constant: computing this lazily is
// what lets tests point it at a temp HOME (AGEN-21) instead of the real
// ~/.agentpulse/supervisor.json.
function getSupervisorConfigPath(): string {
	return join(resolveHomeDir(), ".agentpulse", "supervisor.json");
}

function currentOs() {
	return platform() === "darwin"
		? "macos"
		: platform() === "linux"
			? "linux"
			: platform() === "win32"
				? "windows"
				: "unknown";
}

function buildDefaultConfig(): SupervisorConfig {
	return {
		serverUrl: process.env.AGENTPULSE_SERVER_URL || "http://localhost:3000",
		apiKey: process.env.AGENTPULSE_API_KEY,
		supervisorCredential: process.env.AGENTPULSE_SUPERVISOR_CREDENTIAL,
		enrollmentToken: process.env.AGENTPULSE_SUPERVISOR_ENROLLMENT_TOKEN,
		id: process.env.AGENTPULSE_SUPERVISOR_ID,
		hostName: hostname(),
		platform: platform(),
		arch: arch(),
		version: "0.1.0",
		trustedRoots: [join(homedir(), "dev")],
		claudeCommand: process.env.AGENTPULSE_CLAUDE_COMMAND,
		codexCommand: process.env.AGENTPULSE_CODEX_COMMAND,
		terminalPreference: process.env.AGENTPULSE_TERMINAL_APP,
		capabilities: {
			version: 1,
			agentTypes: ["claude_code", "codex_cli"],
			launchModes: ["headless", "managed_codex"],
			os: currentOs(),
			terminalSupport: [],
			features: [
				"can_write_agents_md",
				"can_write_claude_md",
				"can_run_prelaunch_actions",
				"can_scaffold_workarea",
				"can_clone_repo",
				"can_cleanup_workarea",
				"managed_codex",
				"headless_claude",
			],
		},
	};
}

function canExecute(path: string) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveExecutable(command: string | undefined, fallback: string) {
	const candidate = (command || fallback).trim() || fallback;
	if (isAbsolute(candidate)) {
		return {
			command: candidate,
			resolvedPath: canExecute(candidate) ? candidate : null,
			source: command ? "config" : "auto",
		} as const;
	}

	for (const root of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
		const full = join(root, candidate);
		if (canExecute(full)) {
			return {
				command: candidate,
				resolvedPath: full,
				source: command ? "config" : "auto",
			} as const;
		}
	}

	return {
		command: candidate,
		resolvedPath: null,
		source: command ? "config" : "auto",
	} as const;
}

const EXECUTABLE_VERSION_TIMEOUT_MS = 2_000;
const VERSION_TOKEN_PATTERN = /\d+\.\d+\.\d+/;

/**
 * Spawn `<resolvedPath> --version` and parse a semver-shaped token out of
 * the first line of stdout. Returns `null` on any failure path (missing
 * executable, non-zero exit, empty/garbage output, spawn error, or a
 * timeout past EXECUTABLE_VERSION_TIMEOUT_MS) — never throws, so a broken
 * host binary can't crash supervisor startup (see withExecutableCapabilities).
 *
 * stdout is only read after `proc.exited` resolves successfully (not on
 * abort/non-zero exit): a version script that shells out to another binary
 * (e.g. `sleep`) as a genuine child process can leave that child holding the
 * write end of the stdout pipe open after the parent is killed, so reading
 * the stream unconditionally would block past the abort until the orphaned
 * child exits on its own — defeating the timeout.
 */
export async function captureExecutableVersion(
	resolvedPath: string | null,
): Promise<string | null> {
	if (!resolvedPath) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EXECUTABLE_VERSION_TIMEOUT_MS);
	try {
		const proc = Bun.spawn({
			cmd: [resolvedPath, "--version"],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			signal: controller.signal,
		});
		const exitCode = await proc.exited;
		if (controller.signal.aborted || exitCode !== 0) return null;
		const stdout = await new Response(proc.stdout).text();
		const firstLine = stdout.split("\n")[0]?.trim() ?? "";
		const match = firstLine.match(VERSION_TOKEN_PATTERN);
		return match ? match[0] : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function detectTerminalSupport(config: SupervisorConfig) {
	const detected: string[] = [];
	const preference = config.terminalPreference?.trim();
	const os = currentOs();

	if (preference) {
		detected.push(preference);
	}

	if (os === "macos") {
		if (canExecute("/usr/bin/osascript")) detected.push("terminal_app");
	}

	if (os === "linux") {
		for (const candidate of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
			if (resolveExecutable(undefined, candidate).resolvedPath) detected.push(candidate);
		}
	}

	if (os === "windows") {
		detected.push("windows_terminal");
	}

	return [...new Set(detected)];
}

function detectInteractiveTerminalControl(os: SupervisorRegistrationInput["capabilities"]["os"]) {
	if (!resolveExecutable(undefined, "python3").resolvedPath) {
		return {
			available: false,
			reason: "python3 is required for the interactive session bridge.",
		};
	}

	if (os !== "macos" && os !== "linux") {
		return {
			available: false,
			reason: "Interactive prompt handoff is only implemented for macOS and Linux right now.",
		};
	}

	return {
		available: true,
		reason: null,
	};
}

export async function withExecutableCapabilities(
	config: SupervisorConfig,
): Promise<SupervisorConfig> {
	const claude = resolveExecutable(config.claudeCommand, "claude");
	const codex = resolveExecutable(config.codexCommand, "codex");
	const git = resolveExecutable(undefined, "git");
	const [claudeVersion, codexVersion] = await Promise.all([
		captureExecutableVersion(claude.resolvedPath),
		captureExecutableVersion(codex.resolvedPath),
	]);
	const terminalSupport = detectTerminalSupport(config);
	const interactiveTerminalControl = detectInteractiveTerminalControl(currentOs());
	const launchModes: SupervisorRegistrationInput["capabilities"]["launchModes"] = ["headless"];
	if (terminalSupport.length > 0) launchModes.push("interactive_terminal");
	if (codex.resolvedPath) launchModes.push("managed_codex");
	return {
		...config,
		capabilities: {
			...config.capabilities,
			launchModes,
			terminalSupport,
			features: [
				"can_write_agents_md",
				"can_write_claude_md",
				"can_run_prelaunch_actions",
				"can_cleanup_workarea",
				"headless_claude",
				...(git.resolvedPath ? ["can_scaffold_workarea", "can_clone_repo"] : []),
				...(terminalSupport.length > 0 ? ["interactive_terminal"] : []),
				...(interactiveTerminalControl.available ? ["interactive_terminal_control"] : []),
				...(codex.resolvedPath ? ["managed_codex"] : []),
			],
			interactiveTerminalControl,
			executables: {
				claude: {
					available: Boolean(claude.resolvedPath),
					command: claude.command,
					resolvedPath: claude.resolvedPath,
					source: claude.source,
					binaryVersion: claudeVersion,
				},
				codex: {
					available: Boolean(codex.resolvedPath),
					command: codex.command,
					resolvedPath: codex.resolvedPath,
					source: codex.source,
					binaryVersion: codexVersion,
				},
			},
		},
	};
}

export async function loadSupervisorConfig() {
	const defaults = buildDefaultConfig();
	const file = Bun.file(getSupervisorConfigPath());
	const exists = await file.exists();
	if (exists) {
		const raw = (await file.json()) as Partial<SupervisorConfig>;
		return withExecutableCapabilities({
			...defaults,
			...raw,
			capabilities: {
				...defaults.capabilities,
				...(raw.capabilities ?? {}),
			},
		});
	}

	return withExecutableCapabilities(defaults);
}

/**
 * AGEN-21: routes through writePrivateFileSyncNoFollow (0600, O_NOFOLLOW,
 * symlinked-parent refusal, fchmod on the opened handle) instead of a bare
 * `Bun.write`, which follows a symlink at the destination and leaves the
 * file at the OS-default create mode (0644 under a typical umask) — any
 * local user could read the supervisor credential / enrollment token.
 * Called both on first registration and every credential rotation
 * (src/supervisor/index.ts's main()), so a rotated credential never
 * regresses back to a world-readable file.
 */
export async function saveSupervisorConfig(config: SupervisorConfig) {
	await mkdir(join(resolveHomeDir(), ".agentpulse"), { recursive: true });
	writePrivateFileSyncNoFollow(getSupervisorConfigPath(), JSON.stringify(config, null, 2));
}

/**
 * AGEN-21: call once at supervisor startup, before loadSupervisorConfig().
 * Self-heals an existing supervisor.json left over-permissive by an
 * installer or a pre-fix version of saveSupervisorConfig — corrects it to
 * 0600 in place and logs once. A missing file (fresh install), an
 * already-private file, or a hard-linked path is a silent no-op. Refuses
 * (and logs, but never throws) if the path is a symlink — startup
 * continues either way; the permission fix is a hardening pass, not a
 * load-time gate.
 *
 * AGEN-21 (xander, Medium): tightenPrivateFilePermissionsSync itself
 * throws if it loses its internal TOCTOU race (the file changed identity
 * between the lstat and the verifying fstat) — deliberately, since that's
 * the one path where continuing would risk fchmod'ing the wrong inode.
 * This function is the one place that race is allowed to surface, and it
 * must never propagate: a lost race at startup is not worth crash-looping
 * the supervisor over. Caught, logged, startup continues either way.
 *
 * `tighten` is a test seam (defaults to the real
 * tightenPrivateFilePermissionsSync): the real TOCTOU race is a few CPU
 * instructions wide and can't be hit reliably by racing two real
 * processes in a test, so config-ensure-private-race.test.ts passes a
 * function that throws on demand instead. A default-parameter seam here
 * — not module mocking — because mock.module replaces module resolution
 * process-wide; ../shared/private-file.js is imported by other test
 * files' real-implementation coverage (config.test.ts,
 * private-file.test.ts) that share this test run's module registry, and
 * a mock registered by one file was observed to leak into another
 * (confirmed empirically), corrupting their assertions.
 */
export function ensureSupervisorConfigPrivate(
	tighten: typeof tightenPrivateFilePermissionsSync = tightenPrivateFilePermissionsSync,
): void {
	const path = getSupervisorConfigPath();
	try {
		const result = tighten(path);
		if (result.tightened) {
			console.warn(
				`[supervisor] corrected ${path} permissions to 0600 (was 0${result.previousMode.toString(8)})`,
			);
		} else if (result.reason === "symlink") {
			console.error(`[supervisor] refusing to correct permissions: ${path} is a symlink`);
		}
	} catch (error) {
		console.error(
			`[supervisor] failed to check/correct ${path} permissions: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
