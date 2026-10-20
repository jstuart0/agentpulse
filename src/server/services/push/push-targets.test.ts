/**
 * Guards on how push is reached. Targeting is one policy (push-targets.ts), every
 * trigger goes through `dispatchEvent`, and the send path decrypts tokens without
 * blocking the event loop. These scan the source so a new caller can't skip them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { InMemoryDeviceSource, PolicyPushTargets, type PushSubjectReader } from "./push-targets.js";
import type { PushDevice, PushEvent } from "./types.js";

const SERVER = join(import.meta.dir, "../..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** Repo-relative path -> number of lines matching `pattern`, for non-test source only. */
function occurrences(pattern: RegExp): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of sourceFiles(SERVER)) {
		const hits = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => pattern.test(l)).length;
		if (hits > 0) found.set(relative(SERVER, file), hits);
	}
	return found;
}

describe("trigger sites", () => {
	test("dispatchEvent( is defined once, in push/dispatch.ts", () => {
		const defined = occurrences(/\bfunction dispatchEvent\(/);
		expect([...defined.keys()]).toEqual(["services/push/dispatch.ts"]);
	});

	test("S4 owns eight of Pattern #5's ten call sites; the Ask reply (S5) is the ninth, and the S7 health job (below) the tenth", () => {
		const calls = occurrences(/^(?!\s*(\/\/|\*)).*\bvoid dispatchEvent\(/);
		expect(Object.fromEntries([...calls].sort())).toEqual({
			"services/ai/action-requests-service.ts": 1,
			"services/ai/alert-rule-evaluator.ts": 1,
			"routes/ask.ts": 1,
			"services/ai/runner.ts": 1,
			"services/event-processor.ts": 4,
			"services/launch-dispatch.ts": 1,
		});
	});

	test("the tenth site, the S7 health job, awaits its dispatch (to learn whether to retry) under its own origin", () => {
		expect([...occurrences(/\bdispatchEvent\(event, HEALTH_DISPATCH_ORIGIN\)/).keys()]).toEqual([
			"services/push/push-trigger-ports.ts",
		]);
	});

	test("push is started from index.ts and nowhere else", () => {
		expect([...occurrences(/\bstartPush\(/).keys()].sort()).toEqual([
			"index.ts",
			"services/push/push-runtime.ts",
		]);
	});

	// The digest goes to exactly the devices that are due (each has its own local day), which dispatchEvent's
	// per-event dedupe and all-devices targeting can't express, so its trigger (push-scheduler.ts, through the push-trigger-ports.ts port) sends through the service itself.
	test("only dispatch, the single-device test route and the per-device digest call sendToDevices", () => {
		expect([...occurrences(/\.sendToDevices\(/).keys()].sort()).toEqual([
			"routes/devices.ts",
			"services/push/dispatch.ts",
			"services/push/push-scheduler.ts",
			"services/push/push-trigger-ports.ts",
		]);
	});
});

describe("the send path never decrypts synchronously", () => {
	test("nothing under services/push calls the synchronous decryptSecret or readSendToken", () => {
		const pushFiles = sourceFiles(join(SERVER, "services/push"));
		const offenders = pushFiles.filter((file) =>
			/\bdecryptSecret\(|\bdecryptSecret\b[^A]|\breadSendToken\(\s*\w+\.sendToken\b/.test(
				readFileSync(file, "utf8").replace(/decryptSecretAsync/g, ""),
			),
		);
		expect(offenders.map((f) => relative(SERVER, f))).toEqual([]);
	});

	test("registration encrypts the send token off the event loop: no synchronous encryptSecret on the device request path", () => {
		const source = readFileSync(join(SERVER, "services/mobile-devices-service.ts"), "utf8");
		expect(source.replace(/encryptSecretAsync/g, "")).not.toMatch(/\bencryptSecret\b/);
		expect(source).toContain("await encryptSecretAsync(");
	});

	test("the synchronous readSendToken is used by no production code", () => {
		const users = [...occurrences(/\breadSendToken\(/).keys()].filter(
			(f) => f !== "services/mobile-devices-service.ts" && !f.startsWith("services/push/"),
		);
		expect(users).toEqual([]);
	});
});

describe("PolicyPushTargets", () => {
	const device = (id: string, userId: string, token = "t"): PushDevice => ({
		id,
		userId,
		ownerlessKeyId: userId.startsWith("key:") ? userId.slice(4) : null,
		platform: "ios",
		relayDeviceId: `relay-${id}`,
		sendTokenCiphertext: token,
		kid: "kid",
		publicKey: "AAAA",
		clientServerRef: "ref",
		prefs: {},
	});

	// alice owns session s-alice, bob owns s-bob, s-open has no owner; admin and a member without sessions.
	const owners: Record<string, string | null> = {
		"s-alice": "alice",
		"s-bob": "bob",
		"s-open": null,
	};
	const launches: Record<string, string | null> = { "l-alice": "alice", "l-none": null };
	// Ask threads: t-alice is alice's, t-bob bob's, t-key an ownerless key's (k1), t-orphan has no owner at all.
	const threads: Record<string, { ownerUserId: string | null; ownerKeyId: string | null }> = {
		"t-alice": { ownerUserId: "alice", ownerKeyId: null },
		"t-bob": { ownerUserId: "bob", ownerKeyId: null },
		"t-key": { ownerUserId: null, ownerKeyId: "k1" },
		"t-orphan": { ownerUserId: null, ownerKeyId: null },
	};
	const subjects: PushSubjectReader = {
		sessionOwner: async (id) => (id in owners ? { ownerUserId: owners[id] ?? null } : null),
		launchRequester: async (id) => (id in launches ? { ownerUserId: launches[id] ?? null } : null),
		askThreadOwner: async (id) => threads[id] ?? null,
	};
	const fleet = () =>
		new InMemoryDeviceSource(
			[
				device("alice-phone", "alice"),
				device("alice-ipad", "alice"),
				device("bob-phone", "bob"),
				device("admin-phone", "root"),
				device("keyonly-phone", "key:k1"),
			],
			{
				"alice-phone": "member",
				"alice-ipad": "member",
				"bob-phone": "member",
				"admin-phone": "admin",
				"keyonly-phone": null,
			},
		);
	const ids = async (mode: "solo" | "team", event: PushEvent, source = fleet()) =>
		(await new PolicyPushTargets(source, async () => mode, subjects).resolve(event))
			.map((d) => d.id)
			.sort();
	const ALL = ["admin-phone", "alice-ipad", "alice-phone", "bob-phone", "keyonly-phone"];

	const sessionEvents = (sessionId: string): PushEvent[] => [
		{ type: "permission_wait", sessionId },
		{ type: "turn_completed", sessionId },
		{ type: "session_failed", sessionId },
		{ type: "session_completed", sessionId },
		{ type: "hitl_opened", decision: "ask", sessionId, hitlId: "h", proposalId: "p" },
		{ type: "alert_rule_fired", sessionId, trigger: "stuck" },
		{ type: "stuck", sessionId },
		{ type: "risky", sessionId },
	];

	test("solo: every eligible device hears every event, an ownerless key's included", async () => {
		for (const event of [
			...sessionEvents("s-alice"),
			{ type: "action_request_opened", actionRequestId: "a", actionKind: "k" } as PushEvent,
			{ type: "launch_status", launchId: "l-alice" } as PushEvent,
			{ type: "daily_digest", digestDate: "2026-01-01" } as PushEvent,
		]) {
			expect(await ids("solo", event)).toEqual(ALL);
		}
	});

	test("team: a session-scoped event reaches the session owner's devices only", async () => {
		for (const event of sessionEvents("s-alice")) {
			expect(await ids("team", event)).toEqual(["alice-ipad", "alice-phone"]);
		}
		for (const event of sessionEvents("s-bob")) {
			expect(await ids("team", event)).toEqual(["bob-phone"]);
		}
	});

	test("team: an unowned session reaches the admins' devices", async () => {
		for (const event of sessionEvents("s-open")) {
			expect(await ids("team", event)).toEqual(["admin-phone"]);
		}
	});

	test("team: a session that doesn't exist reaches nobody", async () => {
		for (const event of sessionEvents("s-missing")) {
			expect(await ids("team", event)).toEqual([]);
		}
	});

	test("team: an action request reaches the admins' devices", async () => {
		const event: PushEvent = {
			type: "action_request_opened",
			actionRequestId: "a",
			actionKind: "k",
		};
		expect(await ids("team", event)).toEqual(["admin-phone"]);
	});

	test("an Ask reply reaches the requester's devices in either mode: the person's, else the asking key's; nobody if neither is known", async () => {
		const byUser: PushEvent = {
			type: "ask_reply",
			threadId: "t-alice",
			assistantMessageId: "m",
			requesterUserId: "alice",
			requesterKeyId: "k-x",
		};
		const byKey: PushEvent = {
			...byUser,
			threadId: "t-key",
			requesterUserId: null,
			requesterKeyId: "k1",
		} as PushEvent;
		const nobody: PushEvent = {
			...byUser,
			requesterUserId: null,
			requesterKeyId: null,
		} as PushEvent;
		for (const mode of ["solo", "team"] as const) {
			expect(await ids(mode, byUser)).toEqual(["alice-ipad", "alice-phone"]);
			expect(await ids(mode, byKey)).toEqual(["keyonly-phone"]);
			expect(await ids(mode, nobody)).toEqual([]);
		}
	});

	test("an Ask reply never reaches another person's devices or a device with no live standing", async () => {
		const event: PushEvent = {
			type: "ask_reply",
			threadId: "t-bob",
			assistantMessageId: "m",
			requesterUserId: "bob",
			requesterKeyId: null,
		};
		expect(await ids("team", event)).toEqual(["bob-phone"]);
		const revoked = new InMemoryDeviceSource([device("bob-phone", "bob", "")], {
			"bob-phone": "member",
		});
		expect(await ids("team", event, revoked)).toEqual([]);
	});

	// The matrix the F94 follow-up exists for: the push goes to the requester's devices, and only those
	// whose key could then open the thread. [thread, requester user, requester key, devices that are pushed]
	const ASK_REPLY_MATRIX: Array<[string, string | null, string | null, string[]]> = [
		["t-alice", "alice", null, ["alice-ipad", "alice-phone"]],
		["t-bob", "bob", null, ["bob-phone"]],
		// an admin (or any solo caller) continued someone else's thread: the admin's phone can't open it
		["t-alice", "root", null, []],
		["t-bob", "alice", null, []],
		// an ownerless key's thread continued by a person, and the reverse
		["t-key", "alice", null, []],
		["t-alice", null, "k1", []],
		// an ownerless key asked a thread another ownerless key started
		["t-key", null, "k2", []],
		["t-key", null, "k1", ["keyonly-phone"]],
		// no owner on the thread, or no such thread: nobody, even for its asker
		["t-orphan", "alice", null, []],
		["t-gone", "alice", null, []],
	];
	for (const [threadId, requesterUserId, requesterKeyId, pushed] of ASK_REPLY_MATRIX) {
		test(`ask_reply on ${threadId} asked by ${requesterUserId ?? `key ${requesterKeyId}`}: ${pushed.length === 0 ? "nobody" : pushed.join(", ")}`, async () => {
			const event: PushEvent = {
				type: "ask_reply",
				threadId,
				assistantMessageId: "m",
				requesterUserId,
				requesterKeyId,
			};
			for (const mode of ["solo", "team"] as const) {
				expect(await ids(mode, event)).toEqual(pushed);
			}
		});
	}

	test("a person whose id merely looks like `key:k1` is not the ownerless key k1 (F96): the kind of owner comes from ownerlessKeyId, never from the id's spelling", async () => {
		const lookalike: PushDevice = { ...device("lookalike-phone", "key:k1"), ownerlessKeyId: null };
		const source = new InMemoryDeviceSource([lookalike, device("keyonly-phone", "key:k1")], {
			"lookalike-phone": "member",
			"keyonly-phone": null,
		});
		const byKey: PushEvent = {
			type: "ask_reply",
			threadId: "t-key",
			assistantMessageId: "m",
			requesterUserId: null,
			requesterKeyId: "k1",
		};
		// the real key's phone is pushed; the look-alike person's phone is not, though its `userId` is spelled the same
		expect(await ids("team", byKey, source)).toEqual(["keyonly-phone"]);
		// and the look-alike asking as a person reaches only its own device, never the key's
		const asLookalike: PushEvent = { ...byKey, requesterUserId: "key:k1", requesterKeyId: null };
		expect(await ids("team", asLookalike, source)).toEqual([]);
	});

	test("team: a launch status reaches the requester's devices; none recorded, the admins'; unknown launch, nobody", async () => {
		expect(await ids("team", { type: "launch_status", launchId: "l-alice" })).toEqual([
			"alice-ipad",
			"alice-phone",
		]);
		expect(await ids("team", { type: "launch_status", launchId: "l-none" })).toEqual([
			"admin-phone",
		]);
		expect(await ids("team", { type: "launch_status", launchId: "l-gone" })).toEqual([]);
	});

	test("the daily digest: every device in solo; in team mode nobody, because it is built per owner and must never go to everyone (xander L1)", async () => {
		const digest: PushEvent = { type: "daily_digest", digestDate: "2026-01-01" };
		expect(await ids("solo", digest)).toEqual(ALL);
		expect(await ids("team", digest)).toEqual([]);
	});

	test("team: an ownerless key's device is nobody's target for a session", async () => {
		const only = new InMemoryDeviceSource([device("keyonly-phone", "key:k1")], {
			"keyonly-phone": null,
		});
		for (const event of sessionEvents("s-open")) expect(await ids("team", event, only)).toEqual([]);
		expect(await ids("team", { type: "launch_status", launchId: "l-none" }, only)).toEqual([]);
	});

	test("a device with an empty stored send token is no target in either mode", async () => {
		const source = new InMemoryDeviceSource([device("a", "alice", ""), device("b", "alice")]);
		expect(await ids("solo", sessionEvents("s-alice")[0] as PushEvent, source)).toEqual(["b"]);
		expect(await ids("team", sessionEvents("s-alice")[0] as PushEvent, source)).toEqual(["b"]);
	});

	test("the test button is never broadcast", async () => {
		expect(await ids("solo", { type: "device_test", testId: "t" })).toEqual([]);
		expect(await ids("team", { type: "device_test", testId: "t" })).toEqual([]);
	});

	test("without a subject reader team mode fails closed for session events", async () => {
		const targets = new PolicyPushTargets(fleet(), async () => "team");
		expect(await targets.resolve({ type: "stuck", sessionId: "s-alice" })).toEqual([]);
	});
});
