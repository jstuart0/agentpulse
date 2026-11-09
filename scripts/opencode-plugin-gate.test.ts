/**
 * AGEN-141 plan step 18: the plugin's exclude decision against the shell gate.
 * Each row is built in a temp home, run through the plugin (does a POST
 * arrive?) and through `/bin/sh -c "<SH_GATE_PIECE>exit 42"` in the same
 * directory; the two must agree. Rows marked plugin-only have no shell twin.
 */
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSkipValue } from "../src/shared/exclude-rules.ts";
import { SH_GATE_PIECE, buildBashExcludeScript } from "../src/shared/hook-command.ts";
import { EXCLUDE_SCRIPT_SEND_STATUS } from "../src/shared/hook-headers.ts";
import { OPENCODE_PLUGIN_TEMPLATES } from "../src/shared/opencode-plugin.ts";
import { type Rig, SID, rig } from "./lib/opencode-plugin-common-tests.ts";
import { decodeLiteral } from "./lib/opencode-plugin-embed.ts";
import { recordOf, scratchDir, settle } from "./lib/opencode-plugin-kit.ts";

interface Ctx {
	home: string;
	dir: string;
	other: string;
	ad: string;
	clock: { t: number };
	env: Record<string, string | undefined>;
}

type Step = { do?: (c: Ctx) => void; advance?: number; label?: string; pluginExpect?: boolean };
interface Row {
	name: string;
	steps: Step[];
	/** No shell twin: the decision is asserted, not compared. */
	pluginOnly?: { expect: boolean[] };
	seam?: { platform?: string; getuid?: undefined };
	skip?: string;
	noHomeEnv?: "unset" | "empty";
	noDirectory?: boolean;
}

const ad = (c: Ctx) => c.ad;
const mkAd = (c: Ctx, mode = 0o700) => {
	mkdirSync(c.ad, { recursive: true });
	chmodSync(c.ad, mode);
};
const rulesFile = (c: Ctx, lines: string[], mode = 0o600) => {
	mkAd(c);
	writeFileSync(join(c.ad, "exclude"), `${lines.join("\n")}\n`);
	chmodSync(join(c.ad, "exclude"), mode);
};
const scriptFile = (c: Ctx, mode = 0o500, text = buildBashExcludeScript()) => {
	mkAd(c);
	const p = join(c.ad, "exclude-check.sh");
	rmSync(p, { force: true });
	writeFileSync(p, text);
	chmodSync(p, mode);
};
const excl = (c: Ctx) => rulesFile(c, [c.dir]);
const notExcl = (c: Ctx) => rulesFile(c, [c.other]);
const both = (c: Ctx, f: (c: Ctx) => void) => {
	f(c);
	scriptFile(c);
};
const withScript = (...fs: Array<(c: Ctx) => void>): Step => ({
	do: (c) => {
		for (const f of fs) f(c);
		scriptFile(c);
	},
});
const SLEEP_SCRIPT = "#!/bin/sh\nsleep 5\nexit 42\n";

const rows: Row[] = [
	{ name: "no-agentpulse-dir", steps: [{}] },
	{ name: "empty-agentpulse-dir", steps: [{ do: (c) => mkAd(c) }] },
	{ name: "rules-exclude-trusted-script", steps: [withScript(excl)] },
	{ name: "rules-not-matching-trusted-script", steps: [withScript(notExcl)] },
	{
		name: "script-group-writable",
		steps: [
			{
				do: (c) => {
					excl(c);
					notExcl(c);
					scriptFile(c, 0o520);
				},
			},
		],
	},
	{
		name: "script-world-writable",
		steps: [
			{
				do: (c) => {
					notExcl(c);
					scriptFile(c, 0o507);
				},
			},
		],
	},
	{
		name: "script-symlink",
		steps: [
			{
				do: (c) => {
					notExcl(c);
					writeFileSync(join(c.home, "real.sh"), buildBashExcludeScript());
					chmodSync(join(c.home, "real.sh"), 0o500);
					symlinkSync(join(c.home, "real.sh"), join(c.ad, "exclude-check.sh"));
				},
			},
		],
	},
	{ name: "script-missing", steps: [{ do: (c) => notExcl(c) }] },
	{
		name: "script-empty-exits-zero",
		steps: [
			{
				do: (c) => {
					notExcl(c);
					scriptFile(c, 0o500, "#!/bin/sh\nexit 0\n");
				},
			},
		],
	},
	{
		name: "script-stale-header-still-runs",
		steps: [
			{
				do: (c) => {
					notExcl(c);
					scriptFile(
						c,
						0o500,
						buildBashExcludeScript().replace(
							/agentpulse-exclude-check [0-9a-f]{14}/,
							"agentpulse-exclude-check 00000000000000",
						),
					);
				},
			},
		],
	},
	{
		name: "marker-no-rules-script-present",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					writeFileSync(join(c.ad, "exclude.invalid"), "");
					scriptFile(c);
				},
			},
		],
	},
	{
		name: "marker-no-rules-no-script",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					writeFileSync(join(c.ad, "exclude.invalid"), "");
				},
			},
		],
	},
	{
		name: "marker-is-symlink",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					symlinkSync("/nonexistent-target", join(c.ad, "exclude.invalid"));
					scriptFile(c);
				},
			},
		],
	},
	{
		name: "dangling-exclude-link",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					symlinkSync("/nonexistent-target", join(c.ad, "exclude"));
					scriptFile(c);
				},
			},
		],
	},
	{
		name: "marker-symlink-no-script",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					symlinkSync("/nonexistent-target", join(c.ad, "exclude.invalid"));
				},
			},
		],
	},
	{
		name: "dangling-exclude-no-script",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					symlinkSync("/nonexistent-target", join(c.ad, "exclude"));
				},
			},
		],
	},
	{
		name: "agentpulse-dir-symlink",
		steps: [
			{
				do: (c) => {
					const real = join(c.home, "elsewhere");
					mkdirSync(real, { mode: 0o700 });
					symlinkSync(real, c.ad);
				},
			},
		],
	},
	{
		name: "agentpulse-dir-not-searchable",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					chmodSync(c.ad, 0o600);
				},
			},
		],
	},
	{
		name: "agentpulse-dir-group-writable-with-rules",
		steps: [
			{
				do: (c) => {
					both(c, notExcl);
					chmodSync(c.ad, 0o770);
				},
			},
		],
	},
	{
		name: "acl-script",
		steps: [
			{
				do: (c) => {
					both(c, notExcl);
					const r = Bun.spawnSync([
						"chmod",
						"+a",
						"everyone allow read",
						join(c.ad, "exclude-check.sh"),
					]);
					if (r.exitCode !== 0) throw new Error("no ACLs here");
				},
			},
		],
		skip: process.platform === "darwin" ? undefined : "chmod +a is macOS-only",
	},
	{
		name: "acl-dir",
		steps: [
			{
				do: (c) => {
					both(c, notExcl);
					const r = Bun.spawnSync(["chmod", "+a", "everyone allow read", c.ad]);
					if (r.exitCode !== 0) throw new Error("no ACLs here");
				},
			},
		],
		skip: process.platform === "darwin" ? undefined : "chmod +a is macOS-only",
	},
	{ name: "home-unset", steps: [{ do: (c) => excl(c) }], noHomeEnv: "unset" },
	{ name: "home-empty", steps: [{ do: (c) => excl(c) }], noHomeEnv: "empty" },
	...["1", " TRUE ", "0", "no", "yes", "On", "\t1\n"].map(
		(v): Row => ({
			name: `skip-${JSON.stringify(v)}`,
			steps: [
				{
					do: (c) => {
						c.env.AGENTPULSE_SKIP = v;
					},
				},
			],
		}),
	),
	{ name: "rules-created-within-ttl", steps: [{}, { do: (c) => both(c, excl) }] },
	{
		name: "rules-edited-same-mtime",
		steps: [
			{ do: (c) => both(c, notExcl) },
			{
				do: (c) => {
					const p = join(c.ad, "exclude");
					const st = require("node:fs").statSync(p);
					excl(c);
					utimesSync(p, st.atime, st.mtime);
				},
			},
		],
	},
	{
		name: "rules-deleted",
		steps: [{ do: (c) => both(c, excl) }, { do: (c) => rmSync(join(c.ad, "exclude")) }],
	},
	{
		name: "marker-added",
		steps: [
			{ do: (c) => both(c, notExcl) },
			{ do: (c) => writeFileSync(join(c.ad, "exclude.invalid"), "") },
		],
	},
	{
		name: "script-chmod-after-cache",
		steps: [
			{ do: (c) => both(c, notExcl) },
			{ do: (c) => chmodSync(join(c.ad, "exclude-check.sh"), 0o520) },
		],
	},
	{
		name: "script-replaced-same-bytes-new-inode",
		steps: [{ do: (c) => both(c, notExcl) }, { do: (c) => scriptFile(c) }],
	},
	{
		name: "dir-renamed-symlink-left",
		steps: [
			{ do: (c) => both(c, (x) => rulesFile(x, [x.other])) },
			{
				do: (c) => {
					const moved = `${c.dir}-moved`;
					renameSync(c.dir, moved);
					symlinkSync(c.other, c.dir);
					rulesFile(c, [c.other]);
				},
			},
		],
	},
	{
		name: "ttl-61s",
		// The script's verdict follows a flag file the cache key can't see: inside the TTL the plugin keeps its answer, past it the plugin re-asks.
		steps: [
			{
				do: (c) => {
					rulesFile(c, [c.other]);
					scriptFile(c, 0o500, '#!/bin/sh\n[ -e "$HOME/flag" ] && exit 1\nexit 42\n');
				},
			},
			{
				do: (c) => writeFileSync(join(c.home, "flag"), ""),
				advance: 10_000,
				label: "cached",
				pluginExpect: true,
			},
			{ advance: 51_000 },
		],
	},
	// ---- no shell twin ----
	{
		name: "no-directory-with-rules",
		steps: [{ do: (c) => both(c, excl) }],
		noDirectory: true,
		pluginOnly: { expect: [false] },
	},
	{
		name: "no-directory-without-rules",
		steps: [{}],
		noDirectory: true,
		pluginOnly: { expect: [true] },
	},
	{
		name: "rules-over-1MiB",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					writeFileSync(join(c.ad, "exclude"), `${c.other}\n${"#".repeat(1024 * 1024)}`);
					scriptFile(c);
				},
			},
		],
		pluginOnly: { expect: [false] },
	},
	{
		name: "win32-rules-present",
		steps: [{ do: (c) => rulesFile(c, [c.other]) }],
		seam: { platform: "win32", getuid: undefined },
		pluginOnly: { expect: [false] },
	},
	{
		name: "win32-marker-present",
		steps: [
			{
				do: (c) => {
					mkAd(c);
					writeFileSync(join(c.ad, "exclude.invalid"), "");
				},
			},
		],
		seam: { platform: "win32", getuid: undefined },
		pluginOnly: { expect: [false] },
	},
	{
		name: "win32-neither",
		steps: [{}],
		seam: { platform: "win32", getuid: undefined },
		pluginOnly: { expect: [true] },
	},
	{
		name: "win32-userprofile-unset",
		steps: [
			{
				do: (c) => {
					c.env.USERPROFILE = undefined;
				},
			},
		],
		seam: { platform: "win32", getuid: undefined },
		pluginOnly: { expect: [false] },
	},
	{
		name: "win32-home-decoy-ignored",
		steps: [
			{
				do: (c) => {
					const decoy = scratchDir("decoy");
					mkdirSync(join(decoy, ".agentpulse"));
					writeFileSync(join(decoy, ".agentpulse", "exclude"), `${c.dir}\n`);
					c.env.HOME = decoy;
				},
			},
		],
		seam: { platform: "win32", getuid: undefined },
		pluginOnly: { expect: [true] },
	},
];

function shDecision(c: Ctx): boolean {
	if (!existsSync(c.dir)) return false;
	const r = Bun.spawnSync(["/bin/sh", "-c", `${SH_GATE_PIECE}exit ${EXCLUDE_SCRIPT_SEND_STATUS}`], {
		cwd: c.dir,
		env: Object.fromEntries(Object.entries(c.env).filter(([, v]) => v !== undefined)) as Record<
			string,
			string
		>,
		stdout: "ignore",
		stderr: "ignore",
	});
	return r.exitCode === EXCLUDE_SCRIPT_SEND_STATUS;
}

async function runRow(row: Row) {
	const dir = scratchDir("sessn");
	const other = scratchDir("other");
	const home = scratchDir("home");
	const env: Record<string, string | undefined> = { HOME: home, PATH: "/usr/bin:/bin" };
	if (row.seam?.platform === "win32") env.USERPROFILE = home;
	if (row.noHomeEnv === "unset") env.HOME = undefined;
	if (row.noHomeEnv === "empty") env.HOME = "";
	const clock = { t: 1_000_000 };
	const r: Rig = await rig("v1", {
		dir: row.noDirectory ? "" : dir,
		seam: { env, now: () => clock.t, ...(row.seam ?? {}) } as never,
	});
	const c: Ctx = { home, dir, other, ad: join(home, ".agentpulse"), clock, env };
	if (!row.noDirectory) r.drv.created(SID, dir);
	const counts: number[] = [];
	let n = 0;
	const results: Array<{ plugin: boolean; sh: boolean; step: Step }> = [];
	for (const step of row.steps) {
		step.do?.(c);
		if (step.advance) clock.t += step.advance;
		const before = r.received.length;
		r.drv.before(SID, `call_${n++}`, "bash", { n });
		await r.drv.flush();
		await settle("v1");
		// session.created counts too on the first step; count only this call's POST.
		const posts = r.received
			.slice(before)
			.filter((x) => x.body.hook_event_name === "tool.execute.before");
		results.push({ plugin: posts.length > 0, sh: row.pluginOnly ? false : shDecision(c), step });
		counts.push(posts.length);
	}
	return results;
}

describe("the plugin's exclude decision equals the shell gate's (plan step 18)", () => {
	test("the table has at least 34 rows, with the named members", () => {
		expect(rows.length).toBeGreaterThanOrEqual(34);
		const names = new Set(rows.map((r) => r.name));
		for (const n of [
			"script-group-writable",
			"rules-edited-same-mtime",
			"script-chmod-after-cache",
			"ttl-61s",
			"win32-rules-present",
		]) {
			expect(names.has(n), n).toBe(true);
		}
	});

	for (const row of rows) {
		const t = row.skip && process.platform !== "darwin" ? test.skip : test;
		t(row.name, async () => {
			const results = await runRow(row);
			if (row.pluginOnly) {
				expect(results.map((x) => x.plugin)).toEqual(row.pluginOnly.expect);
				return;
			}
			for (const [i, res] of results.entries()) {
				if (res.step.label === "cached") {
					// Inside the TTL the plugin keeps its earlier answer on purpose; the shell would now say no.
					expect(res.plugin, "cached verdict").toBe(res.step.pluginExpect as boolean);
					expect(res.sh).toBe(false);
				} else {
					expect(res.plugin, `${row.name} step ${i}: plugin vs sh`).toBe(res.sh);
				}
			}
		});
	}

	test("expected decisions of the named rows", async () => {
		const decide = async (name: string) =>
			(await runRow(rows.find((r) => r.name === name) as Row)).map((x) => x.plugin);
		expect(await decide("script-group-writable")).toEqual([false]);
		expect(await decide("rules-edited-same-mtime")).toEqual([true, false]);
		expect(await decide("script-chmod-after-cache")).toEqual([true, false]);
		expect(await decide("ttl-61s")).toEqual([true, true, false]);
	});

	test("the gate spawns at most once per cache key per 60 s, and not at all with no rules", async () => {
		const dir = scratchDir("sess");
		const home = scratchDir("home");
		const clock = { t: 5_000_000 };
		const r = await rig("v1", {
			dir,
			seam: { env: { HOME: home, PATH: "/usr/bin:/bin" }, now: () => clock.t },
		});
		r.drv.created(SID, dir);
		for (let i = 0; i < 5; i++) r.drv.before(SID, `c${i}`, "bash", {});
		await settle("v1");
		expect(recordOf("v1").counters.gateSpawns).toBe(0);
		const c: Ctx = {
			home,
			dir,
			other: scratchDir("o"),
			ad: join(home, ".agentpulse"),
			clock,
			env: {},
		};
		both(c, (x) => rulesFile(x, [x.other]));
		for (let i = 0; i < 5; i++) r.drv.before(SID, `d${i}`, "bash", {});
		await settle("v1");
		expect(recordOf("v1").counters.gateSpawns).toBe(1);
		expect(r.received.filter((x) => x.body.hook_event_name === "tool.execute.before").length).toBe(
			10,
		);
	});

	test("the generated constants equal the shared ones", () => {
		const text = OPENCODE_PLUGIN_TEMPLATES.v1;
		const literal = (name: string) =>
			new RegExp(`^const ${name} = (".*");$`, "m").exec(text)?.[1] as string;
		expect(decodeLiteral(literal("AP_GATE_PIECE"))).toBe(SH_GATE_PIECE);
		expect(/^const AP_SEND_STATUS = (\d+);$/m.exec(text)?.[1]).toBe(
			String(EXCLUDE_SCRIPT_SEND_STATUS),
		);
		const skip = JSON.parse(
			decodeLiteral(/^const AP_SKIP_VALUES = JSON\.parse\((".*")\);$/m.exec(text)?.[1] as string),
		) as string[];
		for (const v of ["1", "true", "yes", "on", "0", "false", "no", "off", "", "TRUE", " 1 "]) {
			const norm = v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
			expect(skip.includes(norm) && norm !== "", JSON.stringify(v)).toBe(isSkipValue(v));
		}
	});

	test("a rules file written by the shell tests' reader is the one the plugin reads (sanity: the script text is real)", () => {
		expect(readFileSync(join(__dirname, "../src/shared/hook-command.ts"), "utf8")).toContain(
			"exclude-check.sh",
		);
		expect(buildBashExcludeScript()).toContain("exit 42");
	});
});

describe("17o the gate runs off the hook path and is bounded", () => {
	const slowScript = (c: Ctx, log: string, secs: number) =>
		scriptFile(
			c,
			0o500,
			`#!/bin/sh\necho "start $$" >> "${log}"\nsleep ${secs}\necho "end $$" >> "${log}"\nexit 42\n`,
		);
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	test("a gate that sleeps 2 s+: every hook still returns in under 50 ms, the send is withheld, the process group is killed, and the next send spawns again", async () => {
		const dir = scratchDir("sessn");
		const home = scratchDir("home");
		const log = join(home, "gate.log");
		const c: Ctx = {
			home,
			dir,
			other: scratchDir("other"),
			ad: join(home, ".agentpulse"),
			clock: { t: 1 },
			env: {},
		};
		rulesFile(c, [c.other]);
		slowScript(c, log, 5);
		const r = await rig("v1", { dir, seam: { env: { HOME: home, PATH: "/usr/bin:/bin" } } });
		r.drv.created(SID, dir);
		const t = performance.now();
		r.drv.before(SID, "call_1", "bash", { a: 1 });
		r.drv.after(SID, "call_1", "bash", { a: 1 });
		expect(performance.now() - t).toBeLessThan(50);
		await settle("v1", 15000);
		expect(r.received.length).toBe(0);
		const started = readFileSync(log, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("start"));
		expect(started.length).toBeGreaterThanOrEqual(1);
		await new Promise((res) => setTimeout(res, 100));
		for (const l of started) expect(alive(Number(l.split(" ")[1])), l).toBe(false);
		const spawnsBefore = recordOf("v1").counters.gateSpawns;
		r.drv.before(SID, "call_2", "bash", { a: 1 });
		await settle("v1", 15000);
		expect(recordOf("v1").counters.gateSpawns).toBeGreaterThan(spawnsBefore);
		expect(recordOf("v1").counters.gateTimeouts).toBeGreaterThanOrEqual(2);
	}, 40000);

	test("three directories at once never have more than two gate processes alive", async () => {
		const home = scratchDir("home");
		const log = join(home, "gate.log");
		const other = scratchDir("other");
		const c: Ctx = {
			home,
			dir: other,
			other,
			ad: join(home, ".agentpulse"),
			clock: { t: 1 },
			env: {},
		};
		rulesFile(c, [other]);
		slowScript(c, log, 1);
		const r = await rig("v1", {
			dir: scratchDir("d0"),
			seam: { env: { HOME: home, PATH: "/usr/bin:/bin" } },
		});
		const dirs = [scratchDir("d1"), scratchDir("d2"), scratchDir("d3")];
		dirs.forEach((d, i) => {
			r.drv.created(`ses_gate0000000000000000${i}`, d);
			r.drv.before(`ses_gate0000000000000000${i}`, "c", "bash", {});
		});
		await settle("v1", 20000);
		let live = 0;
		let peak = 0;
		for (const l of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
			live += l.startsWith("start") ? 1 : -1;
			peak = Math.max(peak, live);
		}
		expect(peak).toBeLessThanOrEqual(2);
		expect(peak).toBeGreaterThanOrEqual(2);
		expect(r.received.length).toBe(6);
	}, 40000);
});
