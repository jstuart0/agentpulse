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

	test("S4 owns eight of Pattern #5's ten call sites; the scheduler (S7) and the Ask reply (S5) add the other two", () => {
		const calls = occurrences(/^(?!\s*(\/\/|\*)).*\bvoid dispatchEvent\(/);
		expect(Object.fromEntries([...calls].sort())).toEqual({
			"services/ai/action-requests-service.ts": 1,
			"services/ai/alert-rule-evaluator.ts": 1,
			"services/ai/runner.ts": 1,
			"services/event-processor.ts": 4,
			"services/launch-dispatch.ts": 1,
		});
	});

	test("push is started from index.ts and nowhere else", () => {
		expect([...occurrences(/\bstartPush\(/).keys()].sort()).toEqual([
			"index.ts",
			"services/push/push-runtime.ts",
		]);
	});

	test("only dispatch and the single-device test route call sendToDevices", () => {
		expect([...occurrences(/\.sendToDevices\(/).keys()].sort()).toEqual([
			"routes/devices.ts",
			"services/push/dispatch.ts",
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
	const subjects: PushSubjectReader = {
		sessionOwner: async (id) => (id in owners ? { ownerUserId: owners[id] ?? null } : null),
		launchRequester: async (id) => (id in launches ? { ownerUserId: launches[id] ?? null } : null),
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
		{ type: "hitl_opened", sessionId, hitlId: "h", proposalId: "p" },
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

	test("team: the daily digest is for each device", async () => {
		expect(await ids("team", { type: "daily_digest", digestDate: "2026-01-01" })).toEqual(ALL);
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
