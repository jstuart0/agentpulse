import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CommandResult,
	LAUNCHD_LABELS,
	LAUNCHD_UPDATER_LABEL,
	REAL_SERVICES_ENV,
	SYSTEMD_UNITS,
	createNoneManager,
	createServiceManager,
	createServiceManagerForTests,
	renderLaunchdTimerPlist,
	renderSystemdTimerUnits,
} from "./service-manager.js";

const INSTALLER = readFileSync(
	join(import.meta.dir, "..", "..", "scripts", "install-local.sh"),
	"utf-8",
);
let home: string | null = null;
afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
	home = null;
});

const spec = {
	bunBin: "/Users/a b/.agentpulse/bun/bin/bun",
	bundlePath: "/Users/a b/.agentpulse/updater/current/updater.js",
	home: "/Users/a b",
	path: "/Users/a b/.agentpulse/bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
};

describe("real adapters fail closed", () => {
	test("constructing launchd or systemd without AGENTPULSE_UPDATER_REAL_SERVICES=1 throws", () => {
		for (const service of ["launchd", "systemd"] as const) {
			expect(() =>
				createServiceManager({ service, components: ["server"], home: "/x", env: {} }),
			).toThrow(REAL_SERVICES_ENV);
			expect(() =>
				createServiceManager({
					service,
					components: ["server"],
					home: "/x",
					env: { [REAL_SERVICES_ENV]: "0" },
				}),
			).toThrow();
			expect(() =>
				createServiceManager({
					service,
					components: ["server"],
					home: "/x",
					env: { [REAL_SERVICES_ENV]: "yes" },
				}),
			).toThrow();
		}
	});
	test("the none manager refuses every swap", async () => {
		const none = createServiceManager({
			service: "none",
			components: ["server"],
			home: "/x",
			env: {},
		});
		expect(await none.preflight()).toBe("no_service_manager");
		await expect(none.stop("server")).rejects.toThrow();
		await expect(createNoneManager().start("server")).rejects.toThrow();
		expect(await none.activeUnits()).toEqual([]);
	});
});

describe("renderers", () => {
	test("launchd plist: label, ProgramArguments start with the recorded Bun, escaped paths, interval and RunAtLoad", () => {
		const plist = renderLaunchdTimerPlist({ ...spec, home: "/Users/a & b" });
		expect(plist).toContain(`<string>${LAUNCHD_UPDATER_LABEL}</string>`);
		const args = plist.slice(
			plist.indexOf("<key>ProgramArguments</key>"),
			plist.indexOf("<key>WorkingDirectory</key>"),
		);
		const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
		expect(strings).toEqual([spec.bunBin, spec.bundlePath, "update", "--auto"]);
		expect(plist).toContain("<string>/Users/a &amp; b/.agentpulse</string>");
		expect(plist).toContain("<key>StartInterval</key>\n  <integer>21600</integer>");
		expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
		expect(plist).toContain(`<key>PATH</key><string>${spec.path}</string>`);
		expect(plist).toContain(`<key>${REAL_SERVICES_ENV}</key><string>1</string>`);
		expect(plist).not.toContain("API_KEY");
	});
	test("systemd units: oneshot with quoted ExecStart, a persistent timer with jitter", () => {
		const { service, timer } = renderSystemdTimerUnits({
			...spec,
			bundlePath: "/h/100%/updater.js",
		});
		expect(service).toContain(
			'ExecStart="/Users/a b/.agentpulse/bun/bin/bun" "/h/100%%/updater.js" "update" "--auto"',
		);
		expect(service).toContain("Type=oneshot");
		expect(service).toContain(`Environment=${REAL_SERVICES_ENV}=1`);
		expect(timer).toContain("Persistent=true");
		expect(timer).toContain("RandomizedDelaySec=1800");
		expect(timer).toContain("WantedBy=timers.target");
	});
	test("the labels and unit names equal the installer's", () => {
		expect(INSTALLER).toContain(`<string>${LAUNCHD_LABELS.server}</string>`);
		expect(INSTALLER).toContain(`<string>${LAUNCHD_LABELS.supervisor}</string>`);
		expect(INSTALLER).toContain(`SERVICE_NAME="${SYSTEMD_UNITS.server}"`);
		expect(INSTALLER).toContain("${SERVICE_NAME}-supervisor");
		expect(SYSTEMD_UNITS.supervisor).toBe(`${SYSTEMD_UNITS.server}-supervisor`);
		// the installer's own units run the recorded Bun by absolute path, as the timer does
		expect(INSTALLER).toContain("<string>${BUN_BIN}</string>");
	});
});

function stub(handler: (cmd: string[]) => CommandResult) {
	const calls: string[][] = [];
	return {
		calls,
		run: async (cmd: string[]) => {
			calls.push(cmd);
			return handler(cmd);
		},
	};
}

describe("launchd adapter (over a stub launchctl)", () => {
	const options = {
		service: "launchd" as const,
		components: ["server", "supervisor"] as const,
		home: "/h",
		env: {},
	};
	test("preflight is no_service_manager when the GUI domain isn't there (an ssh-only login)", async () => {
		const s = stub((cmd) => ({
			code: cmd.join(" ") === "launchctl print gui/501" ? 113 : 0,
			stdout: "",
		}));
		const m = createServiceManagerForTests(
			{ ...options, components: [...options.components] },
			{ run: s.run, uid: 501 },
		);
		expect(await m.preflight()).toBe("no_service_manager");
		const ok = stub(() => ({ code: 0, stdout: "" }));
		const m2 = createServiceManagerForTests(
			{ ...options, components: [...options.components] },
			{ run: ok.run, uid: 501 },
		);
		expect(await m2.preflight()).toBe("ok");
	});
	test("stop is bootout of the label, start is bootstrap of the plist, active is whatever launchd has loaded", async () => {
		const s = stub((cmd) => ({
			code: cmd[1] === "print" && cmd[2] === "gui/501/dev.agentpulse.supervisor" ? 113 : 0,
			stdout: "",
		}));
		const m = createServiceManagerForTests(
			{ ...options, components: [...options.components] },
			{ run: s.run, uid: 501 },
		);
		expect(await m.activeUnits()).toEqual(["server"]);
		await m.stop("server");
		await m.start("server");
		expect(s.calls).toContainEqual(["launchctl", "bootout", "gui/501/dev.agentpulse.local"]);
		expect(s.calls).toContainEqual([
			"launchctl",
			"bootstrap",
			"gui/501",
			"/h/Library/LaunchAgents/dev.agentpulse.local.plist",
		]);
		for (const call of s.calls) expect(call[0]).toBe("launchctl");
	});
	test("a unit is gone only when launchd no longer has it, its pid is gone and its port is closed", async () => {
		let loaded = true;
		let identity: string | null = "Mon Nov 17 10:02:11 2026";
		let open = true;
		const s = stub((cmd) => ({ code: cmd[1] === "print" && !loaded ? 113 : 0, stdout: "" }));
		const m = createServiceManagerForTests(
			{ ...options, components: ["server"] },
			{ run: s.run, uid: 501, identityOf: () => identity, portOpen: async () => open },
		);
		const query = { pid: 4242, startedAt: "Mon Nov 17 10:02:11 2026", port: 3000 };
		expect(await m.isGone("server", query)).toBe(false);
		loaded = false;
		expect(await m.isGone("server", query)).toBe(false);
		identity = "Tue Nov 18 09:00:00 2026"; // the pid is another process now
		expect(await m.isGone("server", query)).toBe(false); // port still open
		open = false;
		expect(await m.isGone("server", query)).toBe(true);
	});
	test("installing the timer writes the plist and bootstraps it; removing boots it out", async () => {
		home = mkdtempSync(join(tmpdir(), "ap-sm-"));
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
		const s = stub(() => ({ code: 0, stdout: "" }));
		const m = createServiceManagerForTests(
			{ ...options, home, components: ["server"] },
			{ run: s.run, uid: 501 },
		);
		await m.installTimer({ ...spec, home });
		expect(
			readFileSync(join(home, "Library", "LaunchAgents", "dev.agentpulse.updater.plist"), "utf-8"),
		).toContain("StartInterval");
		expect(s.calls.at(-1)).toEqual([
			"launchctl",
			"bootstrap",
			"gui/501",
			join(home, "Library", "LaunchAgents", "dev.agentpulse.updater.plist"),
		]);
		await m.removeTimer();
		expect(s.calls.at(-1)).toEqual(["launchctl", "bootout", "gui/501/dev.agentpulse.updater"]);
	});
});

describe("systemd adapter (over a stub systemctl)", () => {
	test("preflight needs XDG_RUNTIME_DIR and the unit files the install recorded", async () => {
		home = mkdtempSync(join(tmpdir(), "ap-sm-"));
		const s = stub(() => ({ code: 0, stdout: "active\n" }));
		const base = { service: "systemd" as const, components: ["server" as const], home };
		const noRuntime = createServiceManagerForTests({ ...base, env: {} }, { run: s.run });
		expect(await noRuntime.preflight()).toBe("no_service_manager");
		const withRuntime = createServiceManagerForTests(
			{ ...base, env: { XDG_RUNTIME_DIR: "/run/user/1000" } },
			{ run: s.run },
		);
		expect(await withRuntime.preflight()).toBe("no_service_manager"); // no unit file yet
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		writeFileSync(join(home, ".config", "systemd", "user", "agentpulse.service"), "[Unit]\n");
		expect(await withRuntime.preflight()).toBe("ok");
	});
	test("stop and start are systemctl --user, and active is is-active", async () => {
		const s = stub((cmd) => ({
			code: 0,
			stdout: cmd[3] === "agentpulse-supervisor" ? "inactive\n" : "active\n",
		}));
		const m = createServiceManagerForTests(
			{
				service: "systemd",
				components: ["server", "supervisor"],
				home: "/h",
				env: { XDG_RUNTIME_DIR: "/r" },
			},
			{ run: s.run },
		);
		expect(await m.activeUnits()).toEqual(["server"]);
		await m.stop("server");
		await m.start("supervisor");
		expect(s.calls).toContainEqual(["systemctl", "--user", "stop", "agentpulse"]);
		expect(s.calls).toContainEqual(["systemctl", "--user", "start", "agentpulse-supervisor"]);
		for (const call of s.calls) expect(call[0]).toBe("systemctl");
	});
});
