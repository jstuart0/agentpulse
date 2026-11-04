/**
 * Managed Codex approvals, end to end (AGEN-87, plan 5.4): a real Hono app on a real database, the real
 * report gate, the real tracker, a real `RpcClient` over real stdio pipes, and a fake `codex app-server`
 * child that replays what Codex 0.163.0 was measured to do (accept runs, decline is honoured, a second
 * answer is ignored, `resolved` follows an answer, an interrupt resolves what is open).
 *
 * What this proves: AgentPulse handles what Codex did on the recorded date. It does not prove Codex still
 * does; the `--real` canary and the protocol gate cover that. The "runtime closed" and "supervisor
 * restart" cases are the tracker's handling of a recorded close, not a measurement of a real crash.
 *
 * Every assertion about Codex is about the exact frames the fake received and whether its next step ran.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../server/db/__test_db.js";
import { eq } from "drizzle-orm";
import { CODEX_APPROVAL_TTL_MS } from "../../shared/codex-approvals.js";
import type { LaunchRequest } from "../../shared/types.js";
import { createRulesWatch } from "../services/exclude-rules-watch.js";
import { type ReportGate, createReportGate } from "../services/report-gate.js";
import { type ReportOutbox, createReportOutbox } from "../services/report-outbox.js";
import {
	SupervisorNetworkError,
	SupervisorRequestError,
	createCredentialTripwire,
	parseRetryAfterMs,
} from "../services/report-resilience.js";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import {
	type CodexApprovalTracker,
	configureCodexApprovals,
	createCodexApprovalTracker,
} from "./codex-approvals.js";
import { launchManagedCodexRequest, stopManagedCodexSession } from "./codex-managed.js";

const { config } = await import("../../server/config.js");
const { initializeDatabase, getDb } = await import("../../server/db/client.js");
const { app } = await import("../../server/app.js");
const { createApiKey } = await import("../../server/auth/api-key.js");
const schema = await import("../../server/db/schema/index.js");
const { codexApprovals, launchRequests, managedSessions } = schema;
const fixtures = await import("../../server/test-utils/team-fixtures.js");
const harness = await import("../../server/test-utils/codex-approvals-harness.js");
const { deleteAllSupervisors } = await import("../../server/services/__test_supervisors.js");

setDefaultTimeout(30_000);

const COMMAND = "item/commandExecution/requestApproval";
const FILE_CHANGE = "item/fileChange/requestApproval";
const ORIGIN = "http://localhost:3000";
const FIXTURE_VERSION = "0.163.0";

const originalDisableAuth = config.disableAuth;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the world one test runs in ----

type Call = { path: string; method: string; ok: boolean; body: unknown };
type Tamper = {
	match: RegExp;
	/** Runs after the real server has answered (so whatever it committed is committed) and may replace the answer. */
	after?: (json: any) => Promise<any> | any;
	once?: boolean;
};

function makeClock() {
	const start = Date.now();
	let offset = 0;
	return {
		wall: () => start + offset,
		mono: () => offset,
		advance: (ms: number) => {
			offset += ms;
		},
	};
}

type World = {
	home: string;
	work: string;
	fakeDir: string;
	logPath: string;
	controlPath: string;
	supervisorId: string;
	token: string;
	serverFeatures: string[] | undefined;
	calls: Call[];
	outage: boolean;
	tampers: Tamper[];
	clock: ReturnType<typeof makeClock>;
	gate: ReportGate;
	outbox: ReportOutbox;
	tracker: CodexApprovalTracker;
	reportedStates: any[];
	sessionIds: string[];
	runtimes: Array<{ dispose: () => Promise<void> }>;
};

let base: {
	root: string;
	manageKey: string;
	personId: string;
	supervisorId: string;
	token: string;
	serverFeatures: string[];
};
let world: World;

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"HOME",
	"AGENTPULSE_CODEX_COMMAND",
	"AGENTPULSE_SERVER_URL",
	"AGENTPULSE_SUPERVISOR_DRY_RUN",
	"FAKE_CODEX_LOG",
	"FAKE_CODEX_CONTROL",
	"FAKE_CODEX_VERSION",
	"FAKE_CODEX_REALISTIC",
	"FAKE_CODEX_NO_RESOLVE",
	"FAKE_CODEX_REQUESTS",
];

async function enrollHost() {
	const name = `e2e-host-${crypto.randomUUID().slice(0, 6)}`;
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${base.manageKey}` },
		body: JSON.stringify({ name }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await registerBody({ hostName: name, enrollmentToken });
	expect(registered.status).toBe(200);
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
		serverFeatures?: string[];
	};
	return {
		id: body.supervisor.id,
		token: body.supervisorCredential,
		serverFeatures: body.serverFeatures ?? [],
	};
}

function registerBody(extra: Record<string, unknown>, token?: string) {
	return app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "X-AgentPulse-Supervisor-Token": token } : {}),
		},
		body: JSON.stringify({
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "managed_codex"],
				os: "linux",
				terminalSupport: [],
				features: [],
				executables: {
					codex: { available: true, command: "codex", resolvedPath: "/bin/codex" },
				},
			},
			trustedRoots: ["/tmp", "/private/tmp", tmpdir()],
			...extra,
		}),
	});
}

beforeAll(async () => {
	for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-approvals-e2e-")));
	const person = await fixtures.seedLocalUser("e2e-person", "admin");
	const manage = await createApiKey("e2e-manage", ["manage"]);
	base = {
		root,
		manageKey: manage.key,
		personId: person.id,
		supervisorId: "",
		token: "",
		serverFeatures: [],
	};
	const enrolled = await enrollHost();
	base.supervisorId = enrolled.id;
	base.token = enrolled.token;
	base.serverFeatures = enrolled.serverFeatures;
});

afterAll(async () => {
	for (const key of ENV_KEYS) {
		if (SAVED_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = SAVED_ENV[key];
	}
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	configureCodexApprovals(null);
	await deleteAllSupervisors();
	rmSync(base.root, { recursive: true, force: true });
});

/** The supervisor's request function, wired straight into the real app. */
function makeRequest(w: () => World) {
	return async (path: string, options?: RequestInit) => {
		const current = w();
		const call: Call = {
			path,
			method: options?.method ?? "GET",
			ok: false,
			body: options?.body ? safeJson(String(options.body)) : undefined,
		};
		current.calls.push(call);
		if (current.outage) throw new SupervisorNetworkError(new Error("server unreachable"));
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-AgentPulse-Supervisor-Token": current.token,
		};
		const passed = new Headers(options?.headers);
		for (const name of ["x-agentpulse-delivery-id", "x-agentpulse-replay"]) {
			const value = passed.get(name);
			if (value) headers[name] = value;
		}
		const res = await app.request(`/api/v1${path}`, {
			method: options?.method,
			body: options?.body as string | undefined,
			headers,
		});
		if (!res.ok) {
			const parsed = (await res.json().catch(() => ({}))) as { error?: string };
			throw new SupervisorRequestError(
				res.status,
				res.statusText,
				parsed.error,
				parseRetryAfterMs(res.headers.get("retry-after"), Date.now()),
			);
		}
		call.ok = true;
		let json: any = await res.json();
		for (const tamper of [...current.tampers]) {
			if (!tamper.match.test(path) || !tamper.after) continue;
			if (tamper.once) current.tampers.splice(current.tampers.indexOf(tamper), 1);
			json = await tamper.after(json);
		}
		return json;
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function newWorld(
	options: { serverUrl?: string; version?: string; features?: "server" | "none" } = {},
) {
	const home = realpathSync(mkdtempSync(join(base.root, "home-")));
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	const work = join(home, "work");
	mkdirSync(work, { recursive: true });
	const fakeDir = join(home, "fake");
	mkdirSync(fakeDir);
	const fakeCodex = installFakeCodex(fakeDir);
	const logPath = join(home, "fake.log");
	const controlPath = join(home, "control.jsonl");
	writeFileSync(controlPath, "");
	process.env.HOME = home;
	process.env.AGENTPULSE_CODEX_COMMAND = fakeCodex;
	process.env.AGENTPULSE_SERVER_URL = options.serverUrl ?? "http://127.0.0.1:3000";
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	process.env.FAKE_CODEX_LOG = logPath;
	process.env.FAKE_CODEX_CONTROL = controlPath;
	process.env.FAKE_CODEX_VERSION = options.version ?? FIXTURE_VERSION;
	process.env.FAKE_CODEX_REALISTIC = "1";
	process.env.FAKE_CODEX_NO_RESOLVE = "";
	process.env.FAKE_CODEX_REQUESTS = "";

	const clock = makeClock();
	const w = {
		home,
		work,
		fakeDir,
		logPath,
		controlPath,
		supervisorId: base.supervisorId,
		token: base.token,
		serverFeatures: options.features === "none" ? undefined : base.serverFeatures,
		calls: [] as Call[],
		outage: false,
		tampers: [] as Tamper[],
		clock,
		reportedStates: [] as any[],
		sessionIds: [] as string[],
		runtimes: [] as Array<{ dispose: () => Promise<void> }>,
	} as unknown as World;
	const rules = createRulesWatch({ home });
	w.outbox = createReportOutbox({ home, supervisorId: base.supervisorId });
	w.gate = createReportGate({
		request: makeRequest(() => w),
		supervisorId: base.supervisorId,
		home,
		version: "e2e",
		rules,
		outbox: w.outbox,
		credentialTripwire: createCredentialTripwire({ now: Date.now }),
		onCredentialRejected: async () => {},
	});
	w.tracker = createCodexApprovalTracker({ gate: w.gate, now: clock.wall, monotonic: clock.mono });
	w.tracker.setServerFeatures(w.serverFeatures);
	configureCodexApprovals(w.tracker);
	return w;
}

beforeEach(() => {
	world = newWorld();
});

afterEach(async () => {
	for (const runtime of world.runtimes.splice(0)) await runtime.dispose().catch(() => {});
	configureCodexApprovals(null);
	await harness.cleanApprovalFixtures(world.sessionIds.splice(0));
	rmSync(world.home, { recursive: true, force: true });
});

// ---- driving it ----

/** A managed Codex launch on the registered host, claimed over HTTP so ownership is real. */
async function launch(): Promise<{ sessionId: string; pid: number }> {
	const sessionId = `e2e-${crypto.randomUUID().slice(0, 8)}`;
	world.sessionIds.push(sessionId);
	await getDb().insert(launchRequests).values({
		launchCorrelationId: sessionId,
		agentType: "codex_cli",
		cwd: world.work,
		requestedSupervisorId: world.supervisorId,
		requestedLaunchMode: "managed_codex",
		status: "validated",
		baseInstructions: "",
		taskPrompt: "do the thing",
	});
	const claimed = await app.request(`/api/v1/supervisors/${world.supervisorId}/launches/claim`, {
		method: "POST",
		headers: { "X-AgentPulse-Supervisor-Token": world.token, "Content-Type": "application/json" },
	});
	const { launchRequest } = (await claimed.json()) as { launchRequest: LaunchRequest | null };
	expect(launchRequest?.launchCorrelationId).toBe(sessionId);
	const request = launchRequest as LaunchRequest;
	expect(world.gate.noteLaunch(request.id, request.launchCorrelationId, request.cwd)).toBe(true);
	const result = await launchManagedCodexRequest(request, {
		reportState: (body) => {
			world.reportedStates.push(body);
			return world.gate.reportState(body);
		},
		reportEvents: (events) => world.gate.reportEvents(sessionId, events),
	});
	world.runtimes.push(result.runtime);
	return { sessionId, pid: result.pid };
}

const control = (frame: unknown) =>
	appendFileSync(world.controlPath, `${JSON.stringify({ send: frame })}\n`);
const killChild = () => appendFileSync(world.controlPath, `${JSON.stringify({ exit: 1 })}\n`);

function commandRequest(id: number | string, over: Record<string, unknown> = {}) {
	return {
		id,
		method: COMMAND,
		params: {
			kind: "command",
			threadId: "thr-1",
			turnId: "turn-1",
			itemId: `item-${id}`,
			startedAtMs: 1,
			environmentId: "local",
			reason: null,
			command: "/bin/zsh -lc 'touch accepted.txt'",
			cwd: world.work,
			commandActions: [{ type: "unknown", command: "touch accepted.txt" }],
			availableDecisions: ["accept", "cancel"],
			...over,
		},
	};
}

function fileChangeFrames(id: number | string, diff = "hello\n", path = `${world.work}/a.txt`) {
	const itemId = `fc-${id}`;
	return {
		started: {
			method: "item/started",
			params: {
				threadId: "thr-1",
				turnId: "turn-1",
				startedAtMs: 1,
				item: {
					type: "fileChange",
					id: itemId,
					status: "inProgress",
					changes: [{ path, kind: { type: "add" }, diff }],
				},
			},
		},
		request: {
			id,
			method: FILE_CHANGE,
			params: {
				threadId: "thr-1",
				turnId: "turn-1",
				itemId,
				startedAtMs: 1,
				reason: null,
				grantRoot: null,
			},
		},
	};
}

async function until<T>(
	check: () => T | Promise<T>,
	options: { timeoutMs?: number; tick?: boolean; what?: string } = {},
): Promise<NonNullable<T>> {
	const deadline = Date.now() + (options.timeoutMs ?? 10_000);
	for (;;) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${options.what ?? "condition"}`);
		if (options.tick !== false) await world.tracker.tick();
		await sleep(15);
	}
}

const rowsFor = (sessionId: string) =>
	getDb().select().from(codexApprovals).where(eq(codexApprovals.sessionId, sessionId));

async function theRow(sessionId: string) {
	return until(async () => (await rowsFor(sessionId))[0], { what: "an approval row", tick: false });
}

const answers = () =>
	readFakeLog(world.logPath)
		.filter((e) => e.answer)
		.map((e) => e.answer);
const ran = () => readFakeLog(world.logPath).filter((e) => e.ran !== undefined);
const approvalCalls = () => world.calls.filter((c) => /approvals/.test(c.path));

async function personHeaders() {
	const headers = await fixtures.cookieHeadersFor(base.personId);
	headers.set("Origin", ORIGIN);
	headers.set("Content-Type", "application/json");
	return headers;
}

async function listApprovals(sessionId: string) {
	const res = await app.request(`/api/v1/sessions/${sessionId}/approvals`, {
		headers: await personHeaders(),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as {
		approvals: Array<{
			id: string;
			state: string;
			outcome: string | null;
			presentationHash: string;
			approvable: boolean;
		}>;
	};
}

async function decide(sessionId: string, decision: "accept" | "decline" | "cancel") {
	const { approvals } = await listApprovals(sessionId);
	const approval = approvals[0];
	const res = await app.request(`/api/v1/sessions/${sessionId}/approvals/${approval.id}/decision`, {
		method: "POST",
		headers: await personHeaders(),
		body: JSON.stringify({
			decision,
			...(decision === "accept" ? { presentationHash: approval.presentationHash } : {}),
		}),
	});
	return { res, approval };
}

/** A launched session whose protocol verdict has reached the server, ready for a request. */
async function readySession() {
	const session = await launch();
	await until(
		async () => {
			const [managed] = await getDb()
				.select()
				.from(managedSessions)
				.where(eq(managedSessions.sessionId, session.sessionId));
			const snapshot = managed?.providerCapabilitySnapshot as Record<string, unknown> | null;
			return snapshot?.agentpulseApprovals;
		},
		{ what: "the verdict in the snapshot", tick: false },
	);
	return session;
}

async function openCommand(id = 0, over: Record<string, unknown> = {}) {
	const session = await readySession();
	control(commandRequest(id, over));
	const row = await theRow(session.sessionId);
	return { ...session, row };
}

const stopRoute = (sessionId: string) =>
	app.request(`/api/v1/sessions/${sessionId}/stop`, {
		method: "POST",
		headers: { Authorization: `Bearer ${base.manageKey}`, "Content-Type": "application/json" },
	});

// ---- the cases ----

describe("a person's answer reaches Codex", () => {
	test("accept: the fake receives exactly one accept, the command runs, and the row closes applied", async () => {
		const { sessionId, row } = await openCommand();
		expect(row.status).toBe("pending");
		expect(row.approvable).toBe(true);
		const { res } = await decide(sessionId, "accept");
		expect(res.status).toBe(200);

		await until(() => answers().length > 0, { what: "the fake to be answered" });

		expect(answers()).toEqual([{ id: 0, result: { decision: "accept" } }]);
		expect(ran()).toEqual([{ ran: 0 }]);
		const closed = await until(
			async () => (await rowsFor(sessionId)).find((r) => r.status === "closed"),
			{ what: "the row to close" },
		);
		expect(closed.closedReason).toBe("applied");
		await until(() => world.tracker.pendingCount() === 0);
	});

	test("the tracker reports the shown command and the host's cwd to the server, never the other way round", async () => {
		const { sessionId } = await openCommand();
		const { approvals } = await listApprovals(sessionId);
		expect(approvals[0].approvable).toBe(true);
		const reports = approvalCalls().filter((c) => /managed-sessions\/.+\/approvals$/.test(c.path));
		expect(reports).toHaveLength(1);
		const body = reports[0].body as Record<string, unknown>;
		expect(body.command).toBe("/bin/zsh -lc 'touch accepted.txt'");
		expect(body.v).toBe(1);
		expect(typeof body.runtimeEpoch).toBe("string");
		expect(body.rpcId).toBe("0");
	});

	test("decline: the fake receives a decline and nothing runs", async () => {
		const { sessionId } = await openCommand();
		const { res } = await decide(sessionId, "decline");
		expect(res.status).toBe(200);

		await until(() => answers().length > 0);

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
		const closed = await until(async () =>
			(await rowsFor(sessionId)).find((r) => r.status === "closed"),
		);
		expect(closed.closedReason).toBe("applied");
		expect(closed.decision).toBe("decline");
	});

	test("cancel: the fake receives a cancel and nothing runs", async () => {
		const { sessionId } = await openCommand();
		const { res } = await decide(sessionId, "cancel");
		expect(res.status).toBe(200);

		await until(() => answers().length > 0);

		expect(answers()).toEqual([{ id: 0, result: { decision: "cancel" } }]);
		expect(ran()).toEqual([]);
	});

	test("a file change is reported with its diff, approved with the hash of what was shown, and runs once", async () => {
		const session = await readySession();
		const frames = fileChangeFrames(7, "hello world\n");
		control(frames.started);
		control(frames.request);
		const row = await theRow(session.sessionId);
		expect(row.requestKind).toBe("file_change");
		expect(row.approvable).toBe(true);
		expect(JSON.stringify(row.presentation)).toContain("hello world");

		const { res } = await decide(session.sessionId, "accept");
		expect(res.status).toBe(200);
		await until(() => answers().length > 0);

		expect(answers()).toEqual([{ id: 7, result: { decision: "accept" } }]);
		expect(ran()).toEqual([{ ran: 7 }]);
	});

	test("a file change with no diff in hand is reported decline-only after the 2 s wait, and an accept cannot be given", async () => {
		const session = await readySession();
		const frames = fileChangeFrames(8);
		// No item/started: the request arrives alone.
		control(frames.request);
		await sleep(50);
		expect(await rowsFor(session.sessionId)).toHaveLength(0);
		world.clock.advance(0);
		// The wait is a timer on the real clock; the test waits it out.
		const row = await until(async () => (await rowsFor(session.sessionId))[0], {
			timeoutMs: 6_000,
			tick: false,
			what: "the report after the diff wait",
		});
		expect(row.approvable).toBe(false);
		expect(row.notApprovableReason).toBe("no_diff");
		const { res } = await decide(session.sessionId, "accept");
		expect(res.status).toBe(409);
	});
});

describe("what the host does when nobody answers, or Codex moves first", () => {
	test("expiry: past its deadline the tracker declines, the fake sees a decline, and the row closes expired", async () => {
		const { sessionId } = await openCommand();

		world.clock.advance(CODEX_APPROVAL_TTL_MS + 61_000);
		await world.tracker.tick();
		await until(() => answers().length > 0);

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
		const closed = await until(async () =>
			(await rowsFor(sessionId)).find((r) => r.status === "closed"),
		);
		expect(closed.closedReason).toBe("expired");
	});

	test("interrupted: Codex resolves it without our answer, nothing is written back, and the row closes interrupted", async () => {
		const { sessionId } = await openCommand();

		control({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		const closed = await until(async () =>
			(await rowsFor(sessionId)).find((r) => r.status === "closed"),
		);

		expect(closed.closedReason).toBe("interrupted");
		expect(answers()).toEqual([]);
		expect(world.tracker.pendingCount()).toBe(0);
	});

	test("runtime closed (a recorded close): the row closes runtime_gone and nothing was written", async () => {
		const { sessionId } = await openCommand();

		killChild();
		const closed = await until(async () =>
			(await rowsFor(sessionId)).find((r) => r.status === "closed"),
		);

		expect(closed.closedReason).toBe("runtime_gone");
		expect(ran()).toEqual([]);
	});

	test("runtime closed after an accept with no confirmation: the row closes outcome_unknown, which reads as 'may have run'", async () => {
		process.env.FAKE_CODEX_NO_RESOLVE = "1";
		const { sessionId } = await openCommand();
		await decide(sessionId, "accept");
		await until(() => answers().length > 0);
		expect(ran()).toEqual([{ ran: 0 }]);

		killChild();
		const closed = await until(async () =>
			(await rowsFor(sessionId)).find((r) => r.status === "closed"),
		);

		expect(closed.closedReason).toBe("outcome_unknown");
		const { approvals } = await listApprovals(sessionId);
		expect(approvals[0].outcome).toBe("may_have_run");
	});

	test("restart (a recorded close): registering again closes only this host's rows at once, and the old tracker then declines", async () => {
		const { sessionId } = await openCommand();

		const again = await registerBody({ id: world.supervisorId, hostName: "e2e-host" }, world.token);
		expect(again.status).toBe(200);
		const body = (await again.json()) as { serverFeatures?: string[] };
		expect(body.serverFeatures).toContain("codex_approvals");
		const [row] = await rowsFor(sessionId);
		expect(row.status).toBe("closed");
		expect(row.closedReason).toBe("runtime_gone");

		// The old process (still holding the request) is told it is closed, and declines.
		await until(() => answers().length > 0);
		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
	});
});

describe("exclude rules", () => {
	const exclude = (dir: string) => {
		const file = join(world.home, ".agentpulse", "exclude");
		writeFileSync(file, `${dir}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
	};

	test("a request for a session that is excluded is declined locally, reports nothing, and sends no request", async () => {
		const session = await readySession();
		exclude(world.work);
		const before = world.calls.length;

		control(commandRequest(0));
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(world.calls.slice(before)).toEqual([]);
		expect(await rowsFor(session.sessionId)).toHaveLength(0);
	});

	test("a request pending when a rule appears is declined at the next beat, and the gate's closing report closes its row", async () => {
		const { sessionId } = await openCommand();
		exclude(world.work);

		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });
		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);

		// The gate's contentless closing report is a live terminal report, not a replay: it closes the row.
		await world.gate.scan();
		const closed = await until(
			async () => (await rowsFor(sessionId)).find((r) => r.status === "closed"),
			{
				tick: false,
			},
		);
		expect(closed.closedReason).toBe("session_stopped");
		const closing = world.calls.filter((c) => /managed-session-state$/.test(c.path)).at(-1);
		expect(closing?.body).toMatchObject({ status: "completed", managedState: "stopped" });
	});

	test("an answer that arrives after a rule appeared is ignored and a decline goes", async () => {
		const { sessionId } = await openCommand();
		await decide(sessionId, "accept");
		exclude(world.work);

		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
	});
});

describe("an outage: a request is never queued", () => {
	test("made during an outage it is declined at its deadline and never delivered later", async () => {
		const session = await readySession();
		world.outage = true;
		control(commandRequest(0));
		await sleep(80);
		await world.tracker.tick();

		expect(world.gate.isOffline()).toBe(true);
		expect(world.outbox.hasPending(session.sessionId)).toBe(false);
		expect(await rowsFor(session.sessionId)).toHaveLength(0);
		expect(answers()).toEqual([]);

		world.clock.advance(CODEX_APPROVAL_TTL_MS - 59_000);
		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });
		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);

		// The server comes back and the gate catches up: nothing about the dead request ever arrives.
		world.outage = false;
		world.gate.noteServerReachable();
		await world.gate.flush();
		await world.tracker.tick();
		await sleep(50);
		expect(await rowsFor(session.sessionId)).toHaveLength(0);
		expect(approvalCalls().filter((c) => c.ok)).toEqual([]);
		expect(world.outbox.hasPending(session.sessionId)).toBe(false);
		expect(ran()).toEqual([]);
	});

	test("with no pending approvals a tick does no sync traffic and reads no clock", async () => {
		await readySession();
		let reads = 0;
		const counting = createCodexApprovalTracker({
			gate: world.gate,
			now: () => {
				reads++;
				return world.clock.wall();
			},
			monotonic: () => {
				reads++;
				return world.clock.mono();
			},
		});
		counting.setServerFeatures(world.serverFeatures);
		const before = world.calls.length;

		for (let i = 0; i < 5; i++) await counting.tick();
		for (let i = 0; i < 5; i++) await world.tracker.tick();

		expect(reads).toBe(0);
		expect(world.calls.slice(before)).toEqual([]);
	});
});

describe("Stop and a person's answer", () => {
	test("Stop before queued answer: the accept is never issued, the fake sees a decline and never an accept", async () => {
		const { sessionId } = await openCommand();
		const { res } = await decide(sessionId, "accept");
		expect(res.status).toBe(200);

		const stop = await stopRoute(sessionId);
		expect(stop.status).toBe(202);
		await world.tracker.tick();
		await until(() => answers().length > 0);

		expect(answers().map((a) => a.result.decision)).toEqual(["decline"]);
		expect(ran()).toEqual([]);
		const [row] = await rowsFor(sessionId);
		expect(row.closedReason).toBe("session_stopped");
		expect(row.firstDeliveredAt).toBeNull();
	});

	test("delayed response after Stop, 2 s round trip: the accept is delivered, and the row reads 'may have run' until the host reports", async () => {
		const { sessionId } = await openCommand();
		await decide(sessionId, "accept");
		world.tampers.push({
			match: /approvals\/sync$/,
			once: true,
			after: async (json) => {
				// The guarded issue has committed; now Stop commits, and the response is slow to arrive.
				expect((await stopRoute(sessionId)).status).toBe(202);
				world.clock.advance(2_000);
				return json;
			},
		});

		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });
		expect(answers()).toEqual([{ id: 0, result: { decision: "accept" } }]);
		expect(ran()).toEqual([{ ran: 0 }]);
		expect((await listApprovals(sessionId)).approvals[0].outcome).toBe("may_have_run");

		await world.tracker.tick();
		await until(
			async () => (await listApprovals(sessionId)).approvals[0].outcome === "approved_sent",
			{
				tick: false,
			},
		);
	});

	test("delayed response after Stop, 4 s round trip: the fake receives a decline, never an accept, and the row closes answer_lapsed", async () => {
		const { sessionId } = await openCommand();
		await decide(sessionId, "accept");
		world.tampers.push({
			match: /approvals\/sync$/,
			once: true,
			after: async (json) => {
				expect((await stopRoute(sessionId)).status).toBe(202);
				world.clock.advance(4_000);
				return json;
			},
		});

		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });
		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
		const closed = await until(async () =>
			(await rowsFor(sessionId)).find((r) => r.status === "closed"),
		);
		expect(closed.closedReason).toBe("answer_lapsed");
	});
});

describe("a sync response is not trusted to say accept", () => {
	test("a garbled response delivers nothing; a later honest one still does", async () => {
		const { sessionId } = await openCommand();
		await decide(sessionId, "accept");
		world.tampers.push({
			match: /approvals\/sync$/,
			once: true,
			after: (json) => ({
				...json,
				answers: [{ approvalId: 5, decision: { accept: true }, revision: "1" }],
			}),
		});

		await world.tracker.tick();
		expect(answers()).toEqual([]);
		world.clock.advance(1_500);
		await until(() => answers().length > 0);
		expect(answers()).toEqual([{ id: 0, result: { decision: "accept" } }]);
	});

	test("an accept for an id this host doesn't hold (a foreign session's, a made-up one) reaches nobody", async () => {
		const { sessionId } = await openCommand();
		world.tampers.push({
			match: /approvals\/sync$/,
			after: (json) => ({
				...json,
				answers: [
					...json.answers,
					{ approvalId: crypto.randomUUID(), decision: "accept", revision: 1 },
					{ approvalId: "00000000-0000-4000-8000-000000000000", decision: "accept", revision: 1 },
				],
			}),
		});

		for (let i = 0; i < 3; i++) {
			await world.tracker.tick();
			world.clock.advance(1_100);
		}

		expect(answers()).toEqual([]);
		expect((await rowsFor(sessionId))[0].status).toBe("pending");
	});

	test("an accept for another runtime's approval id cannot be written to this runtime's request with the same rpc id", async () => {
		const first = await openCommand(0);
		killChild();
		await until(async () => (await rowsFor(first.sessionId))[0]?.status === "closed");
		const staleId = first.row.id;

		world.logPath = join(world.home, "fake-2.log");
		world.controlPath = join(world.home, "control-2.jsonl");
		writeFileSync(world.controlPath, "");
		process.env.FAKE_CODEX_LOG = world.logPath;
		process.env.FAKE_CODEX_CONTROL = world.controlPath;
		const second = await openCommand(0);
		world.tampers.push({
			match: /approvals\/sync$/,
			after: (json) => ({
				...json,
				answers: [...json.answers, { approvalId: staleId, decision: "accept", revision: 1 }],
			}),
		});

		for (let i = 0; i < 3; i++) {
			await world.tracker.tick();
			world.clock.advance(1_100);
		}

		expect(answers()).toEqual([]);
		expect((await rowsFor(second.sessionId))[0].status).toBe("pending");
	});

	test("an accept at the wrong revision becomes a decline, and the row closes revision_changed", async () => {
		const session = await readySession();
		const frames = fileChangeFrames(3);
		control(frames.started);
		control(frames.request);
		await theRow(session.sessionId);
		await decide(session.sessionId, "accept");
		world.tampers.push({
			match: /approvals\/sync$/,
			once: true,
			after: (json) => ({
				...json,
				answers: json.answers.map((a: any) => ({ ...a, revision: a.revision + 1 })),
			}),
		});

		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 3, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
		const closed = await until(async () =>
			(await rowsFor(session.sessionId)).find((r) => r.status === "closed"),
		);
		expect(closed.closedReason).toBe("revision_changed");
	});

	test("a patch that changes what was shown, landing after the sync answer and before the write, becomes a decline", async () => {
		const session = await readySession();
		const frames = fileChangeFrames(4, "one\n");
		control(frames.started);
		control(frames.request);
		await theRow(session.sessionId);
		await decide(session.sessionId, "accept");
		world.tampers.push({
			match: /approvals\/sync$/,
			once: true,
			after: async (json) => {
				control({
					method: "item/fileChange/patchUpdated",
					params: {
						threadId: "thr-1",
						turnId: "turn-1",
						itemId: "fc-4",
						changes: [{ path: `${world.work}/a.txt`, kind: { type: "add" }, diff: "two\n" }],
					},
				});
				await sleep(120);
				return json;
			},
		});

		await world.tracker.tick();
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 4, result: { decision: "decline" } }]);
		expect(ran()).toEqual([]);
	});
});

describe("the protocol gate and the server's word", () => {
	test("an unsupported Codex: the snapshot says so, every request is declined, and no approval request is made", async () => {
		await afterEachNow();
		world = newWorld({ version: "0.100.0" });
		const session = await launch();
		const snapshot = await until(
			async () => {
				const [managed] = await getDb()
					.select()
					.from(managedSessions)
					.where(eq(managedSessions.sessionId, session.sessionId));
				return (managed?.providerCapabilitySnapshot as Record<string, unknown> | null)
					?.agentpulseApprovals;
			},
			{ tick: false },
		);
		expect(snapshot).toBe("unsupported");

		control(commandRequest(0));
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(approvalCalls()).toEqual([]);
		expect(await rowsFor(session.sessionId)).toHaveLength(0);
	});

	test("an insecure transport: advertised as such, every request declined, no approval request made", async () => {
		await afterEachNow();
		world = newWorld({ serverUrl: "http://approvals.invalid:3000" });
		const session = await launch();
		const snapshot = await until(
			async () => {
				const [managed] = await getDb()
					.select()
					.from(managedSessions)
					.where(eq(managedSessions.sessionId, session.sessionId));
				return (managed?.providerCapabilitySnapshot as Record<string, unknown> | null)
					?.agentpulseApprovals;
			},
			{ tick: false },
		);
		expect(snapshot).toBe("insecure_transport");

		control(commandRequest(0));
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(approvalCalls()).toEqual([]);
	});

	test("an old server (it advertises nothing): every request is declined at once and the approval routes are never called", async () => {
		await afterEachNow();
		world = newWorld({ features: "none" });
		const session = await readySession();

		control(commandRequest(0));
		await until(() => answers().length > 0, { tick: false });
		for (let i = 0; i < 3; i++) await world.tracker.tick();

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(approvalCalls()).toEqual([]);
		expect(await rowsFor(session.sessionId)).toHaveLength(0);
	});

	test("a server that stops advertising it (a rollback) puts a held request back to decline", async () => {
		const { sessionId } = await openCommand();

		world.tracker.setServerFeatures(undefined);
		await until(() => answers().length > 0, { tick: false });

		expect(answers()).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect((await rowsFor(sessionId))[0].status).toBe("pending");
	});
});

/** Tears the current world down (the file's afterEach does it again, harmlessly) so a test can build its own. */
async function afterEachNow() {
	for (const runtime of world.runtimes.splice(0)) await runtime.dispose().catch(() => {});
	configureCodexApprovals(null);
	await harness.cleanApprovalFixtures(world.sessionIds.splice(0));
	rmSync(world.home, { recursive: true, force: true });
}

describe("stopping through the real stop path", () => {
	test("a request pending at stop is declined before the interrupt, and the child is gone", async () => {
		const { sessionId, pid } = await openCommand();

		await stopManagedCodexSession(sessionId);

		expect(answers().map((a) => a.result.decision)).toEqual(["decline"]);
		// The fence goes first: the decline is written before the interrupt is sent.
		const order = readFakeLog(world.logPath).flatMap((e) =>
			e.answer ? ["answer"] : e.method === "turn/interrupt" ? ["interrupt"] : [],
		);
		expect(order).toEqual(["answer", "interrupt"]);
		expect(ran()).toEqual([]);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
