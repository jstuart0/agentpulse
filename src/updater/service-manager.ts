/**
 * What the updater needs from the machine's service manager, behind one port with three real behaviours
 * (launchd, systemd, none) and a fake for tests (`test-utils/fake-service-manager.ts`).
 *
 * The real adapters touch launchctl and systemctl, so they exist only behind `AGENTPULSE_UPDATER_REAL_SERVICES=1`,
 * which only the installed shim and the installed updater timer set: constructing one without it throws, so a
 * test, a script or a stray call can never reach the person's real services. The renderers that produce unit and
 * plist text are pure functions and are always available.
 *
 * Stopping a unit is `bootout` (launchd) or `stop` (systemd): a KeepAlive job that is merely killed would be
 * started again. After a stop the unit must be gone from the manager, its recorded pid gone from the process
 * table (read, never signalled) and its port closed. Only the units that were active before a run are started
 * again, and a unit that wasn't active is left alone.
 *
 * `installTimer` and `removeTimer` are not called by anything yet (phase 5's `update auto on|off` will). The scheduled job
 * itself must never call them: replacing the unit that is running it would end it mid-update.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import { processIdentity } from "../shared/process-identity.js";

export type UnitName = "server" | "supervisor";

export interface GoneQuery {
	pid: number | null;
	/** `ps -o lstart=` recorded with the pid; a pid whose start time differs is another process. */
	startedAt: number | string | null;
	port: number | null;
	/** The address the port is checked on; null is loopback. */
	host?: string | null;
}

export interface TimerSpec {
	bunBin: string;
	bundlePath: string;
	home: string;
	/** PATH for the timer's job: must hold git and bun. */
	path: string;
}

export interface ServiceManager {
	readonly kind: "launchd" | "systemd" | "none" | "fake";
	preflight(): Promise<"ok" | "no_service_manager">;
	/** Which of this install's units are active now. */
	activeUnits(): Promise<UnitName[]>;
	stop(unit: UnitName): Promise<void>;
	start(unit: UnitName): Promise<void>;
	isGone(unit: UnitName, query: GoneQuery): Promise<boolean>;
	installTimer(spec: TimerSpec): Promise<void>;
	removeTimer(): Promise<void>;
}

export const LAUNCHD_LABELS: Record<UnitName, string> = {
	server: "dev.agentpulse.local",
	supervisor: "dev.agentpulse.supervisor",
};
export const LAUNCHD_UPDATER_LABEL = "dev.agentpulse.updater";
export const SYSTEMD_UNITS: Record<UnitName, string> = {
	server: "agentpulse",
	supervisor: "agentpulse-supervisor",
};
export const SYSTEMD_UPDATER_UNIT = "agentpulse-updater";
export const UPDATER_INTERVAL_SECONDS = 21_600;
const BOOTSTRAP_TRIES = 5;
export const REAL_SERVICES_ENV = "AGENTPULSE_UPDATER_REAL_SERVICES";

// ---- renderers (pure) ----

function xmlEscape(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/** The plist of the updater's timer job: runs `update --auto` every six hours and at load. */
export function renderLaunchdTimerPlist(spec: TimerSpec): string {
	const workDir = join(spec.home, ".agentpulse");
	const args = [spec.bunBin, spec.bundlePath, "update", "--auto"];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_UPDATER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(spec.home)}</string>
    <key>PATH</key><string>${xmlEscape(spec.path)}</string>
    <key>${REAL_SERVICES_ENV}</key><string>1</string>
  </dict>
  <key>StartInterval</key>
  <integer>${UPDATER_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(workDir, "logs", "updater.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(workDir, "logs", "updater.err.log"))}</string>
</dict>
</plist>
`;
}

/** A word for a systemd `Exec` line: quoted, with `\`, `"` and `%` escaped. */
function systemdWord(text: string): string {
	return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function systemdValue(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

export function renderSystemdTimerUnits(spec: TimerSpec): { service: string; timer: string } {
	const workDir = join(spec.home, ".agentpulse");
	const service = `[Unit]
Description=AgentPulse updater

[Service]
Type=oneshot
WorkingDirectory=${workDir.replaceAll("%", "%%")}
Environment="HOME=${systemdValue(spec.home)}"
Environment="PATH=${systemdValue(spec.path)}"
Environment=${REAL_SERVICES_ENV}=1
ExecStart=${[spec.bunBin, spec.bundlePath, "update", "--auto"].map(systemdWord).join(" ")}
`;
	const timer = `[Unit]
Description=Run the AgentPulse updater

[Timer]
OnBootSec=15min
OnUnitActiveSec=6h
Persistent=true
RandomizedDelaySec=1800

[Install]
WantedBy=timers.target
`;
	return { service, timer };
}

// ---- real adapters ----

export type CommandResult = { code: number; stdout: string };
export type CommandRunner = (cmd: string[]) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (cmd) => {
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => proc.kill(), 30_000);
	try {
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return { code, stdout };
	} finally {
		clearTimeout(timer);
	}
};

export function portIsOpen(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

interface AdapterDeps {
	components: readonly UnitName[];
	home: string;
	uid: number;
	run: CommandRunner;
	exists: (path: string) => boolean;
	env: Record<string, string | undefined>;
	identityOf: (pid: number) => string | null;
	sleep: (ms: number) => Promise<void>;
	/** One line per command that answered non-zero (the command and the code, never output). */
	log: (line: string) => void;
	portOpen: (port: number, host?: string) => Promise<boolean>;
	writeFile: (path: string, text: string) => void;
	removeFile: (path: string) => void;
}

async function processAndPortGone(deps: AdapterDeps, query: GoneQuery): Promise<boolean> {
	if (query.pid !== null) {
		const identity = deps.identityOf(query.pid);
		const same =
			identity !== null && (query.startedAt === null || identity === String(query.startedAt));
		if (same) return false;
	}
	if (query.port !== null && (await deps.portOpen(query.port, query.host ?? undefined)))
		return false;
	return true;
}

function launchdPlist(home: string, unit: UnitName): string {
	return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABELS[unit]}.plist`);
}

function createLaunchd(deps: AdapterDeps): ServiceManager {
	const domain = `gui/${deps.uid}`;
	const loaded = async (label: string) =>
		(await deps.run(["launchctl", "print", `${domain}/${label}`])).code === 0;
	return {
		kind: "launchd",
		async preflight() {
			// An ssh-only login has no GUI domain: bootstrap would fail after the old service was already stopped.
			return (await deps.run(["launchctl", "print", domain])).code === 0
				? "ok"
				: "no_service_manager";
		},
		async activeUnits() {
			const active: UnitName[] = [];
			for (const unit of deps.components) if (await loaded(LAUNCHD_LABELS[unit])) active.push(unit);
			return active;
		},
		async stop(unit) {
			const result = await deps.run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABELS[unit]}`]);
			// 3 and 113: the job wasn't loaded, which is what a stop wants.
			if (![0, 3, 113].includes(result.code)) {
				deps.log(`launchctl bootout ${LAUNCHD_LABELS[unit]} answered ${result.code}`);
				throw new Error("launchctl bootout failed");
			}
		},
		async start(unit) {
			const label = LAUNCHD_LABELS[unit];
			// A job a person disabled would never load; enable is harmless for one that isn't.
			const enabled = await deps.run(["launchctl", "enable", `${domain}/${label}`]);
			if (enabled.code !== 0) deps.log(`launchctl enable ${label} answered ${enabled.code}`);
			let code = 0;
			for (let attempt = 0; attempt < BOOTSTRAP_TRIES; attempt++) {
				code = (await deps.run(["launchctl", "bootstrap", domain, launchdPlist(deps.home, unit)]))
					.code;
				if (code === 0) return;
				deps.log(`launchctl bootstrap ${label} answered ${code}`);
				// 5 (I/O error) and 37 (already bootstrapping) are what a bootout still settling answers.
				if (code !== 5 && code !== 37) break;
				await deps.sleep(500 * (attempt + 1));
			}
			throw new Error("launchctl bootstrap failed");
		},
		async isGone(unit, query) {
			if (await loaded(LAUNCHD_LABELS[unit])) return false;
			return processAndPortGone(deps, query);
		},
		async installTimer(spec) {
			const plist = join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_UPDATER_LABEL}.plist`);
			deps.writeFile(plist, renderLaunchdTimerPlist(spec));
			await deps.run(["launchctl", "bootout", `${domain}/${LAUNCHD_UPDATER_LABEL}`]);
			await deps.run(["launchctl", "bootstrap", domain, plist]);
		},
		async removeTimer() {
			const plist = join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_UPDATER_LABEL}.plist`);
			await deps.run(["launchctl", "bootout", `${domain}/${LAUNCHD_UPDATER_LABEL}`]);
			deps.removeFile(plist);
		},
	};
}

function systemdUnitFile(home: string, name: string): string {
	return join(home, ".config", "systemd", "user", `${name}.service`);
}

function createSystemd(deps: AdapterDeps): ServiceManager {
	const active = async (name: string) => {
		const result = await deps.run(["systemctl", "--user", "is-active", name]);
		// Anything but inactive or failed (activating, deactivating, reloading...) is still the old process.
		return !["inactive", "failed", ""].includes(result.stdout.trim());
	};
	return {
		kind: "systemd",
		async preflight() {
			if (!deps.env.XDG_RUNTIME_DIR) return "no_service_manager";
			for (const unit of deps.components) {
				if (!deps.exists(systemdUnitFile(deps.home, SYSTEMD_UNITS[unit])))
					return "no_service_manager";
			}
			return "ok";
		},
		async activeUnits() {
			const out: UnitName[] = [];
			for (const unit of deps.components) if (await active(SYSTEMD_UNITS[unit])) out.push(unit);
			return out;
		},
		async stop(unit) {
			// `stop` returns when systemd is done (up to TimeoutStopSec, 90 s by default).
			const result = await deps.run(["systemctl", "--user", "stop", SYSTEMD_UNITS[unit]]);
			if (result.code !== 0) {
				deps.log(`systemctl stop ${SYSTEMD_UNITS[unit]} answered ${result.code}`);
				throw new Error("systemctl stop failed");
			}
		},
		async start(unit) {
			const result = await deps.run(["systemctl", "--user", "start", SYSTEMD_UNITS[unit]]);
			if (result.code !== 0) {
				deps.log(`systemctl start ${SYSTEMD_UNITS[unit]} answered ${result.code}`);
				throw new Error("systemctl start failed");
			}
		},
		async isGone(unit, query) {
			if (await active(SYSTEMD_UNITS[unit])) return false;
			return processAndPortGone(deps, query);
		},
		async installTimer(spec) {
			const units = renderSystemdTimerUnits(spec);
			deps.writeFile(systemdUnitFile(deps.home, SYSTEMD_UPDATER_UNIT), units.service);
			deps.writeFile(
				join(deps.home, ".config", "systemd", "user", `${SYSTEMD_UPDATER_UNIT}.timer`),
				units.timer,
			);
			await deps.run(["systemctl", "--user", "daemon-reload"]);
			await deps.run(["systemctl", "--user", "enable", "--now", `${SYSTEMD_UPDATER_UNIT}.timer`]);
		},
		async removeTimer() {
			await deps.run(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UPDATER_UNIT}.timer`]);
			deps.removeFile(systemdUnitFile(deps.home, SYSTEMD_UPDATER_UNIT));
			deps.removeFile(
				join(deps.home, ".config", "systemd", "user", `${SYSTEMD_UPDATER_UNIT}.timer`),
			);
			await deps.run(["systemctl", "--user", "daemon-reload"]);
		},
	};
}

/** The adapter for `service: none`: every swap is refused (nothing here can restart the install). */
export function createNoneManager(): ServiceManager {
	const refuse = async (): Promise<never> => {
		throw new Error("no service manager");
	};
	return {
		kind: "none",
		preflight: async () => "no_service_manager",
		activeUnits: async () => [],
		stop: refuse,
		start: refuse,
		isGone: async () => true,
		installTimer: refuse,
		removeTimer: refuse,
	};
}

export interface ServiceManagerOptions {
	service: "launchd" | "systemd" | "none";
	components: readonly UnitName[];
	home: string;
	env: Record<string, string | undefined>;
}

function adapterDeps(
	options: ServiceManagerOptions,
	overrides: Partial<AdapterDeps> = {},
): AdapterDeps {
	return {
		components: options.components,
		home: options.home,
		uid: process.getuid?.() ?? 0,
		run: defaultRunner,
		exists: existsSync,
		env: options.env,
		identityOf: processIdentity,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log: (line) => console.error(`[updater] ${line}`),
		portOpen: (port, host) => portIsOpen(port, host),
		writeFile: (path, text) => writePrivateFileAtomicNoFollow(path, text),
		removeFile: (path) => {
			try {
				unlinkSync(path);
			} catch {
				// already gone
			}
		},
		...overrides,
	};
}

/**
 * The production factory. A launchd or systemd adapter is built only when `AGENTPULSE_UPDATER_REAL_SERVICES=1`;
 * otherwise this throws, so nothing but the installed shim and timer can reach launchctl or systemctl.
 */
export function createServiceManager(options: ServiceManagerOptions): ServiceManager {
	if (options.service === "none") return createNoneManager();
	if (options.env[REAL_SERVICES_ENV] !== "1") {
		throw new Error(
			`the ${options.service} service manager is only used with ${REAL_SERVICES_ENV}=1`,
		);
	}
	const deps = adapterDeps(options);
	return options.service === "launchd" ? createLaunchd(deps) : createSystemd(deps);
}

/** Test only: an adapter over a stub command runner, so no real launchctl or systemctl is reachable. */
export function createServiceManagerForTests(
	options: ServiceManagerOptions,
	overrides: Partial<Omit<AdapterDeps, "components" | "home" | "env">> & Pick<AdapterDeps, "run">,
): ServiceManager {
	const deps = adapterDeps(options, overrides);
	return options.service === "launchd" ? createLaunchd(deps) : createSystemd(deps);
}
