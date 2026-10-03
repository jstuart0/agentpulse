/**
 * A supervisor that registers without (or with partial) capabilities used to
 * be stored as `{}` and read back without `agentTypes`/`terminalSupport`, so
 * every consumer that dereferenced them threw: POST /templates/preview
 * returned 500 for everyone and the Ask "resume" flow crashed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions, supervisors } = await import("../db/schema/index.js");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { templatesRouter } = await import("./templates.js");
const { getSupervisor, listSupervisors } = await import("../services/supervisor-registry.js");
const { handleResumeIntent } = await import("../services/ask/ask-resume-handler.js");

const originalDisableAuth = config.disableAuth;

const app = new Hono().route("/api/v1", supervisorsAgentRouter).route("/api/v1", templatesRouter);

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(supervisors).execute();
	await getDb().delete(sessions).execute();
});

afterAll(async () => {
	await getDb().delete(supervisors).execute();
	await getDb().delete(sessions).execute();
	config.disableAuth = originalDisableAuth;
});

function register(extra: Record<string, unknown>) {
	return app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "caps-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			trustedRoots: ["/tmp"],
			...extra,
		}),
	});
}

function preview() {
	return app.request("/api/v1/templates/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "t", cwd: "/tmp", agentType: "claude_code" }),
	});
}

async function resumeCodexSession() {
	await getDb()
		.insert(sessions)
		.values({
			sessionId: crypto.randomUUID(),
			displayName: "resume-me",
			agentType: "codex_cli",
			status: "completed",
			cwd: "/tmp",
			isArchived: false,
		})
		.execute();
	return handleResumeIntent({
		intent: { kind: "resume", sessionHint: null, newPrompt: "keep going" },
		origin: "web",
		threadId: crypto.randomUUID(),
	});
}

const DEFAULTED_FIELDS = {
	version: 1,
	agentTypes: [],
	launchModes: [],
	os: "unknown",
	terminalSupport: [],
	features: [],
};

describe("registering a supervisor with missing or partial capabilities", () => {
	const variants: [string, Record<string, unknown>][] = [
		["no capabilities field", {}],
		["empty capabilities object", { capabilities: {} }],
		["null capabilities", { capabilities: null }],
		["a partial capabilities object", { capabilities: { agentTypes: ["claude_code"] } }],
	];

	for (const [label, body] of variants) {
		test(`${label}: stored with defaults, preview returns 200, resume does not throw`, async () => {
			const res = await register(body);
			expect(res.status).toBe(200);
			const { supervisor } = (await res.json()) as {
				supervisor: { id: string; capabilities: Record<string, unknown> };
			};
			expect(supervisor.capabilities).toMatchObject({
				...DEFAULTED_FIELDS,
				...((body.capabilities as object | null) ?? {}),
			});

			const stored = await getSupervisor(supervisor.id);
			expect(stored?.capabilities.terminalSupport).toEqual([]);

			const previewRes = await preview();
			expect(previewRes.status).toBe(200);

			const resumed = await resumeCodexSession();
			expect(typeof resumed.replyText).toBe("string");
		});
	}

	test("partial capabilities keep what the supervisor did send", async () => {
		const res = await register({
			capabilities: { agentTypes: ["codex_cli"], terminalSupport: ["tmux"] },
		});
		const { supervisor } = (await res.json()) as {
			supervisor: { capabilities: Record<string, unknown> };
		};
		expect(supervisor.capabilities.agentTypes).toEqual(["codex_cli"]);
		expect(supervisor.capabilities.terminalSupport).toEqual(["tmux"]);
		expect(supervisor.capabilities.launchModes).toEqual([]);
	});
});

describe("registering a supervisor with wrongly typed capabilities", () => {
	const bad: [string, unknown, string][] = [
		["a string", "claude_code", "capabilities"],
		["an array", ["claude_code"], "capabilities"],
		["agentTypes as a string", { agentTypes: "claude_code" }, "agentTypes"],
		["agentTypes holding a number", { agentTypes: [1] }, "agentTypes"],
		["terminalSupport as an object", { terminalSupport: {} }, "terminalSupport"],
		["os as a number", { os: 7 }, "os"],
		["executables as a string", { executables: "claude" }, "executables"],
	];

	for (const [label, capabilities, field] of bad) {
		test(`${label}: 400 naming the field, nothing stored`, async () => {
			const res = await register({ capabilities });
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string; field: string };
			expect(body.error).toBe("invalid_capabilities");
			expect(body.field).toBe(field);
			expect(await listSupervisors()).toEqual([]);
		});
	}
});

describe("a supervisor row stored before capabilities were normalised", () => {
	async function insertLegacy(id: string, capabilities: Record<string, unknown>) {
		await getDb()
			.insert(supervisors)
			.values({
				id,
				hostName: "legacy-host",
				platform: "linux",
				arch: "x64",
				version: "0.9.0",
				capabilities,
				trustedRoots: ["/tmp"],
				heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();
	}

	test("`{}` reads back with every default", async () => {
		await insertLegacy("legacy-empty", {});
		const read = await getSupervisor("legacy-empty");
		expect(read?.capabilities).toMatchObject(DEFAULTED_FIELDS);
		expect((await listSupervisors())[0]?.capabilities).toMatchObject(DEFAULTED_FIELDS);
	});

	test("a partial object is merged with defaults key by key", async () => {
		await insertLegacy("legacy-partial", { agentTypes: ["claude_code"], terminalSupport: 5 });
		const read = await getSupervisor("legacy-partial");
		expect(read?.capabilities.agentTypes).toEqual(["claude_code"]);
		expect(read?.capabilities.terminalSupport).toEqual([]);
		expect(read?.capabilities.features).toEqual([]);
	});

	test("preview and resume survive a legacy `{}` row", async () => {
		await insertLegacy("legacy-survive", {});
		expect((await preview()).status).toBe(200);
		expect(typeof (await resumeCodexSession()).replyText).toBe("string");
	});
});

// ── Hostile and oversized input ──────────────────────────────────────────────

function registerRaw(body: string, headers: Record<string, string> = {}) {
	return app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
}

function rawBody(capabilities: string, extra = ""): string {
	return `{"hostName":"h","platform":"linux","arch":"x64","version":"1.0.0","trustedRoots":["/tmp"]${extra},"capabilities":${capabilities}}`;
}

async function storedCapabilities(id: string): Promise<Record<string, unknown>> {
	const { eq } = await import("drizzle-orm");
	const [row] = await getDb().select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	return row?.capabilities as Record<string, unknown>;
}

const KNOWN_KEYS = [
	"agentTypes",
	"executables",
	"features",
	"interactiveTerminalControl",
	"launchModes",
	"os",
	"terminalSupport",
	"version",
];

describe("keys that collide with Object.prototype members", () => {
	test("registering with __proto__, constructor and hasOwnProperty keys succeeds, drops them, and pollutes nothing", async () => {
		const res = await registerRaw(
			rawBody(
				'{"__proto__":{"polluted":true},"constructor":"x","hasOwnProperty":1,"toString":null,"agentTypes":["claude_code"]}',
			),
		);
		expect(res.status).toBe(200);
		const { supervisor } = (await res.json()) as { supervisor: { id: string } };
		const stored = await storedCapabilities(supervisor.id);
		expect(Object.keys(stored).sort()).toEqual([...KNOWN_KEYS].filter((k) => k in stored).sort());
		expect(Object.hasOwn(stored, "__proto__")).toBe(false);
		expect(Object.hasOwn(stored, "constructor")).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(stored.agentTypes).toEqual(["claude_code"]);
	});

	test("unknown keys are dropped, not stored", async () => {
		const res = await registerRaw(rawBody('{"somethingNew":{"a":1},"agentTypes":[]}'));
		const { supervisor } = (await res.json()) as { supervisor: { id: string } };
		expect(Object.hasOwn(await storedCapabilities(supervisor.id), "somethingNew")).toBe(false);
	});

	const legacy: [string, string][] = [
		["a __proto__ key", '{"__proto__":{"x":1},"agentTypes":["claude_code"]}'],
		["a constructor key", '{"constructor":{"prototype":1}}'],
		["a hasOwnProperty key", '{"hasOwnProperty":1}'],
		["a number", "7"],
		["a string", '"nope"'],
		["an array", '["claude_code"]'],
		[
			"values of the wrong type everywhere",
			'{"agentTypes":1,"launchModes":"x","features":{},"os":[],"version":"1","executables":5,"interactiveTerminalControl":"y","terminalSupport":null}',
		],
	];

	for (const [label, json] of legacy) {
		test(`a stored row holding ${label} is read back without throwing, with usable capabilities`, async () => {
			await getDb()
				.insert(supervisors)
				.values({
					id: "legacy-hostile",
					hostName: "legacy-host",
					platform: "linux",
					arch: "x64",
					version: "0.9.0",
					capabilities: JSON.parse(json),
					trustedRoots: ["/tmp"],
					heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				})
				.execute();
			const list = await listSupervisors();
			expect(list.length).toBe(1);
			const caps = list[0]?.capabilities;
			expect(Array.isArray(caps?.terminalSupport)).toBe(true);
			expect(Array.isArray(caps?.agentTypes)).toBe(true);
			expect(Array.isArray(caps?.launchModes)).toBe(true);
			expect(Array.isArray(caps?.features)).toBe(true);
			expect((await preview()).status).toBe(200);
		});
	}
});

describe("limits", () => {
	test("a body over 64 KB is refused with 413", async () => {
		const res = await registerRaw(rawBody("{}", `,"padding":"${"x".repeat(70_000)}"`));
		expect(res.status).toBe(413);
	});

	test("a body that is not JSON is a 400, not a 500", async () => {
		expect((await registerRaw("{nope")).status).toBe(400);
		expect((await registerRaw("null")).status).toBe(400);
	});

	const tooBig: [string, string, string][] = [
		[
			"a features list over the length cap",
			`{"features":${JSON.stringify(Array(500).fill("f"))}}`,
			"features",
		],
		["a very long feature string", `{"features":["${"f".repeat(5000)}"]}`, "features"],
		["a very long os string", `{"os":"${"o".repeat(5000)}"}`, "os"],
		[
			"a very long resolvedPath",
			`{"executables":{"claude":{"available":true,"command":"claude","resolvedPath":"/${"p".repeat(9000)}","source":"auto"}}}`,
			"executables",
		],
	];
	for (const [label, caps, field] of tooBig) {
		test(`${label}: 400 naming ${field}`, async () => {
			const res = await registerRaw(rawBody(caps));
			expect(res.status).toBe(400);
			expect(((await res.json()) as { field: string }).field).toBe(field);
		});
	}

	test("executables entries are checked one by one", async () => {
		for (const entry of [
			'{"available":"yes","command":"claude","resolvedPath":null,"source":"auto"}',
			'{"available":true,"command":"claude","resolvedPath":7,"source":"auto"}',
			"5",
			'{"available":true,"command":"claude","resolvedPath":null,"source":"weird"}',
		]) {
			const res = await registerRaw(rawBody(`{"executables":{"claude":${entry}}}`));
			expect(res.status, entry).toBe(400);
			expect(((await res.json()) as { field: string }).field).toBe("executables");
		}
	});

	test("a valid executables entry is stored", async () => {
		const entry =
			'{"available":true,"command":"claude","resolvedPath":"/usr/bin/claude","source":"auto","binaryVersion":null}';
		const res = await registerRaw(rawBody(`{"executables":{"claude":${entry},"extra":1}}`));
		expect(res.status).toBe(200);
		const { supervisor } = (await res.json()) as { supervisor: { id: string } };
		const stored = (await storedCapabilities(supervisor.id)) as {
			executables: Record<string, unknown>;
		};
		expect(stored.executables.claude).toEqual(JSON.parse(entry));
		expect(Object.hasOwn(stored.executables, "extra")).toBe(false);
	});
});

describe("capability checks run after authentication", () => {
	test("with auth on, an unauthenticated caller gets 401 for hostile and invalid bodies alike", async () => {
		const previous = config.disableAuth;
		config.disableAuth = false;
		try {
			for (const caps of [
				'{"__proto__":{"x":1},"hasOwnProperty":1}',
				'{"agentTypes":"not-a-list"}',
				'"x"',
			]) {
				const res = await registerRaw(rawBody(caps));
				expect(res.status, caps).toBe(401);
			}
			expect(await listSupervisors()).toEqual([]);
		} finally {
			config.disableAuth = previous;
		}
	});
});

describe("a refused registration does not spend the enrollment token", () => {
	const withAuthOn = async (run: () => Promise<void>) => {
		const previous = config.disableAuth;
		config.disableAuth = false;
		try {
			await run();
		} finally {
			config.disableAuth = previous;
		}
	};

	test("a scoped token with malformed capabilities gets 400, then still registers", async () => {
		const first = await register({});
		const { supervisor } = (await first.json()) as { supervisor: { id: string } };
		const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
		const { token } = await createSupervisorEnrollmentToken("rekey", null, supervisor.id, null);

		await withAuthOn(async () => {
			const bad = await register({ enrollmentToken: token, capabilities: { agentTypes: "x" } });
			expect(bad.status).toBe(400);
			const badRoots = await register({ enrollmentToken: token, trustedRoots: ["relative"] });
			expect(badRoots.status).toBe(400);

			const good = await register({ enrollmentToken: token, capabilities: {} });
			expect(good.status).toBe(200);
			const body = (await good.json()) as {
				supervisor: { id: string };
				supervisorCredential: string;
			};
			expect(body.supervisor.id).toBe(supervisor.id);
			expect(body.supervisorCredential).toBeTruthy();

			const reused = await register({ enrollmentToken: token });
			expect(reused.status).toBe(401);
		});
	});

	test("an unauthenticated oversized body is refused with 413 before it is parsed", async () => {
		await withAuthOn(async () => {
			const res = await registerRaw(rawBody("{}", `,"padding":"${"x".repeat(70_000)}"`));
			expect(res.status).toBe(413);
		});
		expect(await listSupervisors()).toEqual([]);
	});
});

// ── trustedRoots ─────────────────────────────────────────────────────────────

describe("trustedRoots", () => {
	const invalid: [string, string][] = [
		["a string", '"/tmp"'],
		["an object", "{}"],
		["a number element", "[1]"],
		["an empty string element", '[""]'],
		["a relative path", '["dev/projects"]'],
		["a dot-dot relative path", '["../x"]'],
		["too many entries", JSON.stringify(Array(200).fill("/tmp"))],
		["a very long path", `["/${"p".repeat(9000)}"]`],
	];
	for (const [label, roots] of invalid) {
		test(`${label}: 400 invalid_trusted_roots, nothing stored`, async () => {
			const res = await registerRaw(
				`{"hostName":"h","platform":"linux","arch":"x64","version":"1","trustedRoots":${roots},"capabilities":{}}`,
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe("invalid_trusted_roots");
			expect(await listSupervisors()).toEqual([]);
		});
	}

	test("absolute POSIX and Windows paths are accepted", async () => {
		const res = await registerRaw(
			'{"hostName":"h","platform":"linux","arch":"x64","version":"1","trustedRoots":["/home/u/dev","C:\\\\Users\\\\u\\\\dev","\\\\\\\\server\\\\share"],"capabilities":{}}',
		);
		expect(res.status).toBe(200);
	});

	for (const [label, roots] of [
		["a string", "x"],
		["an array with a number", [1]],
		["an object", { a: 1 }],
	] as const) {
		test(`a stored row with trustedRoots as ${label} reads back as no roots; preview and launch validation do not throw`, async () => {
			await getDb()
				.insert(supervisors)
				.values({
					id: "legacy-roots",
					hostName: "legacy-host",
					platform: "linux",
					arch: "x64",
					version: "0.9.0",
					capabilities: {},
					trustedRoots: roots as unknown as string[],
					heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				})
				.execute();
			const read = await getSupervisor("legacy-roots");
			expect(read?.trustedRoots).toEqual([]);
			expect((await preview()).status).toBe(200);
			const { validateAgainstSupervisor } = await import("../services/launch-compatibility.js");
			expect(() =>
				validateAgainstSupervisor(
					{ name: "t", cwd: "/tmp", agentType: "claude_code" } as never,
					read as never,
					"headless",
				),
			).not.toThrow();
		});
	}
});

// ── each field check is pinned; the route stores the normalised value ───────

describe("each capability field is checked", () => {
	const wrong: [string, string][] = [
		["version", '{"version":"1"}'],
		["version", '{"version":null}'],
		["launchModes", '{"launchModes":"headless"}'],
		["launchModes", '{"launchModes":[1]}'],
		["features", '{"features":"x"}'],
		["features", '{"features":[{}]}'],
		["interactiveTerminalControl", '{"interactiveTerminalControl":"yes"}'],
		["interactiveTerminalControl", '{"interactiveTerminalControl":{"available":"yes"}}'],
		["interactiveTerminalControl", '{"interactiveTerminalControl":{"available":true,"reason":5}}'],
		["agentTypes", '{"agentTypes":[null]}'],
		["terminalSupport", '{"terminalSupport":[1]}'],
		["os", '{"os":false}'],
	];
	for (const [field, caps] of wrong) {
		test(`${field} ${caps}: 400 naming the field`, async () => {
			const res = await registerRaw(rawBody(caps));
			expect(res.status).toBe(400);
			expect(((await res.json()) as { field: string }).field).toBe(field);
		});
	}

	test("a terminal-control entry without a reason registers, and null is allowed too", async () => {
		for (const tc of [
			'{"available":true}',
			'{"available":false,"reason":null}',
			'{"available":false,"reason":"no tmux"}',
		]) {
			const res = await registerRaw(rawBody(`{"interactiveTerminalControl":${tc}}`));
			expect(res.status, tc).toBe(200);
		}
	});

	test("the route stores the normalised value, not the raw body", async () => {
		for (const caps of ["{}", "null", '{"agentTypes":["claude_code"]}']) {
			await getDb().delete(supervisors).execute();
			const res = await registerRaw(rawBody(caps));
			const { supervisor } = (await res.json()) as { supervisor: { id: string } };
			const stored = await storedCapabilities(supervisor.id);
			expect(stored).toMatchObject({ ...DEFAULTED_FIELDS, ...(JSON.parse(caps) ?? {}) });
		}
	});

	test("valid values of every field survive unchanged", async () => {
		const caps = {
			version: 1,
			agentTypes: ["claude_code", "codex_cli"],
			launchModes: ["headless"],
			os: "macos",
			terminalSupport: ["tmux"],
			features: ["can_cleanup_workarea"],
			interactiveTerminalControl: { available: true },
		};
		const res = await registerRaw(rawBody(JSON.stringify(caps)));
		const { supervisor } = (await res.json()) as { supervisor: { id: string } };
		expect(await storedCapabilities(supervisor.id)).toEqual(caps);
	});
});
