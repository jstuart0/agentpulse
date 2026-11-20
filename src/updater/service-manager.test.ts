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

describe("hardened service handling (stub runners)", () => {
	const launchd = (handler: (cmd: string[]) => CommandResult, logs: string[] = []) => {
		const s = stub(handler);
		const m = createServiceManagerForTests(
			{ service: "launchd", components: ["server"], home: "/h", env: {} },
			{ run: s.run, uid: 501, sleep: async () => {}, log: (l) => void logs.push(l) },
		);
		return { m, calls: s.calls, logs };
	};

	test("launchd start enables the job first, then bootstraps", async () => {
		const { m, calls } = launchd(() => ({ code: 0, stdout: "" }));
		await m.start("server");
		expect(calls.map((c) => c[1])).toEqual(["enable", "bootstrap"]);
		expect(calls[0]).toEqual(["launchctl", "enable", "gui/501/dev.agentpulse.local"]);
	});

	test("bootstrap is retried on 5 and 37, logged, and gives up after a few tries", async () => {
		let n = 0;
		const ok = launchd((cmd) => ({ code: cmd[1] === "bootstrap" && ++n < 3 ? 5 : 0, stdout: "" }));
		await ok.m.start("server");
		expect(ok.calls.filter((c) => c[1] === "bootstrap")).toHaveLength(3);
		expect(ok.logs.some((l) => l.includes("answered 5"))).toBe(true);
		const bad = launchd((cmd) => ({ code: cmd[1] === "bootstrap" ? 37 : 0, stdout: "" }));
		await expect(bad.m.start("server")).rejects.toThrow("bootstrap failed");
		expect(bad.calls.filter((c) => c[1] === "bootstrap")).toHaveLength(5);
		// another code is not retried
		const once = launchd((cmd) => ({ code: cmd[1] === "bootstrap" ? 1 : 0, stdout: "" }));
		await expect(once.m.start("server")).rejects.toThrow();
		expect(once.calls.filter((c) => c[1] === "bootstrap")).toHaveLength(1);
	});

	test("bootout: not-loaded is fine, any other failure is an error and is logged", async () => {
		await launchd(() => ({ code: 113, stdout: "" })).m.stop("server");
		const bad = launchd(() => ({ code: 1, stdout: "" }));
		await expect(bad.m.stop("server")).rejects.toThrow("bootout failed");
		expect(bad.logs[0]).toContain("answered 1");
	});

	test("systemd: activating, deactivating and reloading all still count as active; inactive and failed don't", async () => {
		for (const [state, active] of [
			["activating", true],
			["deactivating", true],
			["reloading", true],
			["active", true],
			["inactive", false],
			["failed", false],
		] as const) {
			const s = stub(() => ({ code: 0, stdout: `${state}\n` }));
			const m = createServiceManagerForTests(
				{ service: "systemd", components: ["server"], home: "/h", env: { XDG_RUNTIME_DIR: "/r" } },
				{ run: s.run },
			);
			expect(await m.activeUnits(), state).toEqual(active ? ["server"] : []);
		}
	});

	test("systemd stop and start fail loudly on a non-zero exit", async () => {
		const logs: string[] = [];
		const s = stub(() => ({ code: 1, stdout: "" }));
		const m = createServiceManagerForTests(
			{ service: "systemd", components: ["server"], home: "/h", env: {} },
			{ run: s.run, log: (l) => void logs.push(l) },
		);
		await expect(m.stop("server")).rejects.toThrow("stop failed");
		await expect(m.start("server")).rejects.toThrow("start failed");
		expect(logs).toHaveLength(2);
	});

	test("the stop wait allows systemd's default 90 s TimeoutStopSec", async () => {
		const { DEFAULT_TIMING } = await import("./updater.js");
		expect(DEFAULT_TIMING.stopMs).toBeGreaterThanOrEqual(100_000);
	});

	test("the port-closed check is made on the address the server binds", async () => {
		const seen: (string | undefined)[] = [];
		const m = createServiceManagerForTests(
			{ service: "launchd", components: ["server"], home: "/h", env: {} },
			{
				run: async () => ({ code: 113, stdout: "" }),
				uid: 501,
				portOpen: async (_p, host) => {
					seen.push(host);
					return false;
				},
			},
		);
		await m.isGone("server", { pid: null, startedAt: null, port: 3000, host: "192.0.2.7" });
		await m.isGone("server", { pid: null, startedAt: null, port: 3000 });
		expect(seen).toEqual(["192.0.2.7", undefined]);
	});
});
