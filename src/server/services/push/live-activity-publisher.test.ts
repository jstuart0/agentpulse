/**
 * The Live Activity publisher against fakes for everything outside it (the
 * relay-facing service, the activity table, the session reader, the device
 * rules), so each rule is driven directly: coalescing, the 75-second trace
 * cadence, every way an activity ends, and the eligibility check before a send.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Session, SessionEvent } from "../../../shared/types.js";
import {
	ACTIVITY_MAX_AGE_MS,
	BACKOFF_MS,
	BUCKET_MS,
	COMPLETED_DISMISSAL_SEC,
	LiveActivityPublisher,
	type LiveActivityRow,
	type SessionView,
} from "./live-activity-publisher.js";
import type { ActivityOutcome, ActivityUpdate } from "./push-service.js";
import type { EligibleDevice } from "./push-targets.js";
import type { PushDevice } from "./types.js";

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

const device = (id: string, userId: string): PushDevice => ({
	id,
	userId,
	platform: "ios",
	relayDeviceId: `relay-${id}`,
	sendTokenCiphertext: "stored",
	kid: "kid",
	publicKey: "AAAA",
	clientServerRef: "ref",
	prefs: {},
});

interface Sent {
	deviceId: string;
	update: ActivityUpdate;
}

class Harness {
	now = T0;
	bus = new EventEmitter();
	sent: Sent[] = [];
	ended: string[] = [];
	liveRows: LiveActivityRow[] = [];
	session: SessionView | null = {
		ownerUserId: "alice",
		status: "working",
		toolCount: 3,
		archived: false,
	};
	mode: "solo" | "team" = "team";
	devices = new Map<string, EligibleDevice>();
	outcome: (deviceId: string) => ActivityOutcome["status"] = () => "sent";
	retryAfterSec: number | null = null;
	rejectError: string | null = null;
	signalRevalidation: () => Promise<void> = async () => undefined;
	listCalls = 0;
	lookupCalls = 0;
	readOwnersError: Error | null = null;
	warnings: { message: string; fields?: Record<string, unknown> }[] = [];
	publisher: LiveActivityPublisher;

	constructor() {
		this.devices.set("phone", { device: device("phone", "alice"), role: "member" });
		this.publisher = new LiveActivityPublisher({
			service: {
				sendActivityUpdate: async (d, update) => {
					this.sent.push({ deviceId: d.id, update });
					const status = this.outcome(d.id);
					const base = { deviceId: d.id, slot: update.slot };
					if (status === "rejected") {
						return { ...base, status, httpStatus: 404, error: this.rejectError };
					}
					if (status === "budget_limited") {
						return { ...base, status, retryAfterSec: this.retryAfterSec };
					}
					return { ...base, status } as ActivityOutcome;
				},
			},
			store: {
				liveRows: async () => this.liveRows,
				endRow: async (deviceId, sessionId) => {
					this.ended.push(`${deviceId}|${sessionId}`);
				},
			},
			readSession: async () => this.session,
			eligibleDevices: async () => {
				this.listCalls += 1;
				return [...this.devices.values()];
			},
			eligibleDevice: async (id) => {
				this.lookupCalls += 1;
				return this.devices.get(id) ?? null;
			},
			readOwners: async (ids) => {
				if (this.readOwnersError) throw this.readOwnersError;
				return new Map(
					this.session ? ids.map((id) => [id, this.session?.ownerUserId ?? null]) : [],
				);
			},
			observeRevalidation: (observer) => {
				this.signalRevalidation = observer;
				return () => {
					this.signalRevalidation = async () => undefined;
				};
			},
			mode: async () => this.mode,
			bus: this.bus as never,
			clock: { now: () => this.now },
			logger: {
				info: () => undefined,
				warn: (message, fields) => {
					this.warnings.push({ message, fields });
				},
			},
		});
	}

	row(deviceId = "phone", sessionId = "s1", slot = "slot-1"): LiveActivityRow {
		return { deviceId, sessionId, slot, generation: 1, startedAtMs: this.now };
	}

	/** A tool event for a followed session. */
	toolEvent(sessionId = "s1") {
		this.bus.emit("session_event", {
			sessionId,
			event: { eventType: "PostToolUse" } as SessionEvent,
		});
	}

	updated(over: Partial<Session> & { sessionId?: string } = {}) {
		if (this.session && "ownerUserId" in over) this.session.ownerUserId = over.ownerUserId ?? null;
		this.bus.emit("session_updated", {
			sessionId: "s1",
			operationalStatus: "working",
			ownerUserId: "alice",
			totalToolUses: 3,
			isArchived: false,
			...over,
		} as Session);
	}

	/** Lets the fire-and-forget bus handlers finish. */
	async settle() {
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	}

	events(kind?: "update" | "end") {
		return this.sent.filter((s) => (kind ? s.update.event === kind : true));
	}
}

let h: Harness;
beforeEach(() => {
	h = new Harness();
	h.publisher.start();
});

const state = (s: Sent) =>
	s.update.contentState as {
		status: string;
		statusSince: number;
		toolCount: number;
		trace: number[];
	};

describe("following", () => {
	test("sends the first state at once, in the closed contract shape", async () => {
		await h.publisher.follow(h.row());
		expect(h.sent).toHaveLength(1);
		const first = h.sent[0] as Sent;
		expect(first.update.event).toBe("update");
		expect(Object.keys(first.update.contentState).sort()).toEqual([
			"status",
			"statusSince",
			"toolCount",
			"trace",
		]);
		expect(state(first)).toMatchObject({ status: "working", toolCount: 3 });
		expect(state(first).trace).toHaveLength(24);
		expect(state(first).statusSince).toBe(Math.floor(T0 / 1000));
		expect(first.update.staleDate).toBeGreaterThan(Math.floor(T0 / 1000));
		expect(JSON.stringify(first.update.contentState).length).toBeLessThan(1024);
	});

	test("a session that doesn't exist ends the row and sends nothing", async () => {
		h.session = null;
		await h.publisher.follow(h.row());
		expect(h.sent).toEqual([]);
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("only followed sessions are tracked: events for others are ignored", async () => {
		h.toolEvent("other");
		await h.publisher.tick();
		expect(h.sent).toEqual([]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("unfollow ends the row and tells the phone to end the activity", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		await h.publisher.unfollow(h.row());
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.events("end")).toHaveLength(1);
		expect(h.publisher.watchedSessions).toBe(0);
	});
});

describe("status transitions", () => {
	test("a status change is sent immediately, with the new statusSince", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.now += 10_000;
		h.updated({ operationalStatus: "waiting" });
		await h.settle();
		expect(h.sent).toHaveLength(1);
		expect(state(h.sent[0] as Sent)).toMatchObject({
			status: "waiting",
			statusSince: Math.floor((T0 + 10_000) / 1000),
		});
	});

	test("an update that changes no status sends nothing by itself", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.updated({ operationalStatus: "working" });
		await h.settle();
		expect(h.sent).toEqual([]);
	});

	test("every followed device gets the transition, each judged on its own", async () => {
		h.devices.set("ipad", { device: device("ipad", "alice"), role: "member" });
		await h.publisher.follow(h.row("phone"));
		await h.publisher.follow(h.row("ipad"));
		h.sent = [];
		h.updated({ operationalStatus: "error" });
		await h.settle();
		expect(h.sent.map((s) => s.deviceId).sort()).toEqual(["ipad", "phone"]);
	});
});

describe("trace cadence", () => {
	test("events inside a bucket are folded into one update, sent no sooner than 75 s after the last send", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		for (let i = 0; i < 5; i++) h.toolEvent();
		h.now += 30_000;
		await h.publisher.tick();
		expect(h.sent).toEqual([]); // too soon after the first state

		h.now += BUCKET_MS;
		await h.publisher.tick();
		expect(h.sent).toHaveLength(1);
		const body = state(h.sent[0] as Sent);
		expect(body.toolCount).toBe(8); // 3 + 5 tool events
		expect(body.trace.reduce((a, b) => a + b, 0)).toBe(5);

		h.now += BUCKET_MS;
		await h.publisher.tick();
		expect(h.sent).toHaveLength(1); // nothing happened since: nothing to send
	});

	test("the trace rolls forward a bucket at a time, oldest first", async () => {
		await h.publisher.follow(h.row());
		h.toolEvent();
		h.now += BUCKET_MS * 2;
		h.toolEvent();
		h.toolEvent();
		h.sent = [];
		await h.publisher.tick();
		const { trace } = state(h.sent[0] as Sent);
		expect(trace.slice(-3).join(",")).toBe("1,0,2");
	});

	test("a trace older than the window is all zeros", async () => {
		await h.publisher.follow(h.row());
		h.toolEvent();
		h.now += BUCKET_MS * 40;
		h.toolEvent();
		h.sent = [];
		await h.publisher.tick();
		const { trace } = state(h.sent[0] as Sent);
		expect(trace.reduce((a, b) => a + b, 0)).toBe(1);
		expect(trace[23]).toBe(1);
	});

	test("counts are clamped to the contract maximum", async () => {
		await h.publisher.follow(h.row());
		for (let i = 0; i < 10_050; i++) h.toolEvent();
		h.now += BUCKET_MS;
		h.sent = [];
		await h.publisher.tick();
		expect(Math.max(...state(h.sent[0] as Sent).trace)).toBe(9999);
	});

	test("a relay budget refusal holds trace updates back, then they resume", async () => {
		await h.publisher.follow(h.row());
		h.toolEvent();
		h.now += BUCKET_MS;
		h.outcome = () => "budget_limited";
		h.retryAfterSec = 120;
		h.sent = [];
		await h.publisher.tick();
		expect(h.sent).toHaveLength(1);

		h.now += 60_000; // inside the relay's retry-after
		await h.publisher.tick();
		expect(h.sent).toHaveLength(1);

		h.outcome = () => "sent";
		h.now += 61_000;
		await h.publisher.tick();
		expect(h.sent).toHaveLength(2);

		h.toolEvent();
		h.now += BUCKET_MS;
		await h.publisher.tick();
		expect(h.sent).toHaveLength(3);
	});

	test("a refusal with no hint backs off for a fixed time", async () => {
		await h.publisher.follow(h.row());
		h.toolEvent();
		h.now += BUCKET_MS;
		h.outcome = () => "rate_limited";
		h.sent = [];
		await h.publisher.tick();
		h.now += BACKOFF_MS - 1_000;
		await h.publisher.tick();
		expect(h.sent).toHaveLength(1);
		h.now += 2_000;
		await h.publisher.tick();
		expect(h.sent).toHaveLength(2);
	});
});

describe("the ways an activity ends", () => {
	test("completed: ends with a 15 minute dismissal and stops tracking", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.updated({ operationalStatus: "completed" });
		await h.settle();
		const [end] = h.events("end");
		expect(end?.update.dismissalDate).toBe(Math.floor(T0 / 1000) + COMPLETED_DISMISSAL_SEC);
		expect(state(end as Sent).status).toBe("completed");
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("archived: ends at once", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.updated({ isArchived: true, operationalStatus: "completed" });
		await h.settle();
		const [end] = h.events("end");
		expect(end?.update.dismissalDate).toBe(Math.floor(T0 / 1000));
		expect(h.ended).toEqual(["phone|s1"]);
	});

	test("gone:activity from the relay closes the row", async () => {
		await h.publisher.follow(h.row());
		h.toolEvent();
		h.now += BUCKET_MS;
		h.outcome = () => "activity_gone";
		h.ended = [];
		await h.publisher.tick();
		expect(h.ended).toEqual(["phone|s1"]);
		h.outcome = () => "sent";
		h.sent = [];
		h.toolEvent();
		h.now += BUCKET_MS;
		await h.publisher.tick();
		expect(h.sent).toEqual([]);
	});

	test("8 hours: ends the activity", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.now += ACTIVITY_MAX_AGE_MS;
		await h.publisher.tick();
		expect(h.events("end")).toHaveLength(1);
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("a device whose key was revoked: the row is closed and nothing can be sent", async () => {
		await h.publisher.follow(h.row());
		h.devices.delete("phone");
		h.sent = [];
		h.toolEvent();
		h.now += BUCKET_MS;
		await h.publisher.tick();
		expect(h.sent).toEqual([]);
		expect(h.ended).toEqual(["phone|s1"]);
		h.toolEvent();
		h.now += BUCKET_MS;
		await h.publisher.tick();
		expect(h.sent).toEqual([]);
	});

	test("an ownership handover ends the activity of the device that lost access, and tells it nothing about the session", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.updated({ ownerUserId: "bob" });
		await h.settle();
		const [end] = h.events("end");
		expect(end?.deviceId).toBe("phone");
		expect(state(end as Sent)).toMatchObject({ status: "completed", toolCount: 0 });
		expect(state(end as Sent).trace.every((n) => n === 0)).toBe(true);
		expect(h.ended).toEqual(["phone|s1"]);
	});

	test("a handover keeps the activity of a device that can still read the session", async () => {
		h.devices.set("admin-phone", { device: device("admin-phone", "root"), role: "admin" });
		await h.publisher.follow(h.row("phone"));
		await h.publisher.follow(h.row("admin-phone"));
		h.sent = [];
		h.updated({ ownerUserId: "bob" });
		await h.settle();
		expect(h.events("end").map((s) => s.deviceId)).toEqual(["phone"]);
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(1);
	});

	test("a handover in solo mode changes nothing: everyone reads everything", async () => {
		h.mode = "solo";
		await h.publisher.follow(h.row());
		h.sent = [];
		h.updated({ ownerUserId: "bob" });
		await h.settle();
		expect(h.events("end")).toEqual([]);
		expect(h.ended).toEqual([]);
	});
});

describe("eligibility is judged on every send", () => {
	test("a status change does not reach a device that is no longer eligible", async () => {
		h.devices.set("ipad", { device: device("ipad", "alice"), role: "member" });
		await h.publisher.follow(h.row("phone"));
		await h.publisher.follow(h.row("ipad"));
		h.devices.delete("ipad");
		h.sent = [];
		h.updated({ operationalStatus: "waiting" });
		await h.settle();
		expect(h.sent.map((s) => s.deviceId)).toEqual(["phone"]);
		expect(h.ended).toEqual(["ipad|s1"]);
	});

	test("following a session the device's user cannot read closes the row without a send", async () => {
		h.session = { ownerUserId: "bob", status: "working", toolCount: 0, archived: false };
		await h.publisher.follow(h.row());
		expect(h.events("update")).toEqual([]);
		expect(h.ended).toEqual(["phone|s1"]);
	});
});

describe("start and stop", () => {
	test("after a restart, rows still marked live are picked up and finished sessions are closed", async () => {
		const fresh = new Harness();
		fresh.liveRows = [fresh.row("phone", "s1"), fresh.row("phone", "s2")];
		fresh.session = { ownerUserId: "alice", status: "working", toolCount: 0, archived: false };
		fresh.publisher.start();
		await fresh.settle();
		expect(fresh.publisher.watchedSessions).toBe(2);

		const done = new Harness();
		done.liveRows = [done.row("phone", "gone")];
		done.session = { ownerUserId: "alice", status: "completed", toolCount: 0, archived: false };
		done.publisher.start();
		await done.settle();
		expect(done.publisher.watchedSessions).toBe(0);
		expect(done.ended).toEqual(["phone|gone"]);
		fresh.publisher.stop();
		done.publisher.stop();
	});

	test("stop unsubscribes: events after it do nothing", async () => {
		await h.publisher.follow(h.row());
		h.publisher.stop();
		expect(h.bus.listenerCount("session_event")).toBe(0);
		expect(h.bus.listenerCount("session_updated")).toBe(0);
	});

	test("start is idempotent: one subscription however often it is called", () => {
		h.publisher.start();
		h.publisher.start();
		expect(h.bus.listenerCount("session_event")).toBe(1);
	});
});

describe("a handover that no session update announces", () => {
	test("handing over an idle session ends the old owner's activity with a neutral end within one tick", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		(h.session as SessionView).ownerUserId = "bob"; // changeSessionOwner emits no session_updated
		await h.publisher.tick();
		const [end] = h.events("end");
		expect(end?.deviceId).toBe("phone");
		expect(state(end as Sent)).toMatchObject({ status: "completed", toolCount: 0 });
		expect(state(end as Sent).trace.every((n) => n === 0)).toBe(true);
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("the revalidation signal acts at once, without waiting for a tick", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		(h.session as SessionView).ownerUserId = "bob";
		await h.signalRevalidation();
		expect(h.events("end")).toHaveLength(1);
		expect(h.ended).toEqual(["phone|s1"]);
	});

	test("a signal for many followed sessions reads the eligible devices once, not once per row", async () => {
		for (const id of ["s1", "s2", "s3"]) {
			h.devices.set(`phone-${id}`, { device: device(`phone-${id}`, "alice"), role: "member" });
			await h.publisher.follow(h.row(`phone-${id}`, id, `slot-${id}`));
		}
		h.listCalls = 0;
		h.lookupCalls = 0;
		await h.signalRevalidation();
		expect(h.listCalls).toBe(1);
		expect(h.lookupCalls).toBe(0);
	});

	test("the batched signal judges each row on its own device", async () => {
		h.devices.set("tablet", { device: device("tablet", "alice"), role: "member" });
		await h.publisher.follow(h.row("phone"));
		await h.publisher.follow(h.row("tablet", "s1", "slot-t"));
		h.sent = [];
		h.devices.delete("tablet"); // revoked: nothing can be sent to it, the row is only closed
		await h.signalRevalidation();
		expect(h.sent).toEqual([]);
		expect(h.ended).toEqual(["tablet|s1"]);
		(h.session as SessionView).ownerUserId = "bob"; // control: the same pass ends a device that lost read access
		await h.signalRevalidation();
		expect(h.events("end").map((s) => s.deviceId)).toEqual(["phone"]);
		expect(h.ended).toEqual(["tablet|s1", "phone|s1"]);
	});

	test("a failing signal is logged, not swallowed, and does not throw", async () => {
		await h.publisher.follow(h.row());
		h.readOwnersError = new Error("db down");
		await h.signalRevalidation();
		expect(h.warnings.map((w) => w.message)).toEqual(["live activity revalidation failed"]);
		expect(h.warnings[0]?.fields).toEqual({ error: "Error" });
		expect(h.ended).toEqual([]);
	});

	test("an owner who is unchanged keeps the activity through a tick and a signal", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		await h.publisher.tick();
		await h.signalRevalidation();
		expect(h.events("end")).toEqual([]);
		expect(h.ended).toEqual([]);
	});

	test("a session deleted meanwhile ends its activities", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		h.session = null;
		await h.publisher.tick();
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("stop unsubscribes from the signal", async () => {
		await h.publisher.follow(h.row());
		h.publisher.stop();
		(h.session as SessionView).ownerUserId = "bob";
		h.sent = [];
		await h.signalRevalidation();
		expect(h.sent).toEqual([]);
	});

	test("unfollowing a session whose owner changed sends a neutral end, not the real state", async () => {
		h.session = { ownerUserId: "alice", status: "working", toolCount: 42, archived: false };
		await h.publisher.follow(h.row());
		h.sent = [];
		(h.session as SessionView).ownerUserId = "bob";
		await h.publisher.unfollow(h.row());
		const [end] = h.events("end");
		expect(state(end as Sent).toolCount).toBe(0);
	});

	test("unfollowing one's own session still sends the real state", async () => {
		await h.publisher.follow(h.row());
		h.sent = [];
		await h.publisher.unfollow(h.row());
		expect(state(h.events("end")[0] as Sent).toolCount).toBe(3);
	});
});

describe("a relay that says the activity is not there", () => {
	const flushOnce = async () => {
		h.toolEvent();
		h.now += BUCKET_MS;
		await h.publisher.tick();
	};

	test("two refusals in a row finish the row; one does not", async () => {
		await h.publisher.follow(h.row());
		h.outcome = () => "rejected";
		h.rejectError = "unknown_slot";
		await flushOnce();
		expect(h.ended).toEqual([]);
		await flushOnce();
		expect(h.ended).toEqual(["phone|s1"]);
		expect(h.publisher.watchedSessions).toBe(0);
	});

	test("stale_generation counts the same", async () => {
		await h.publisher.follow(h.row());
		h.outcome = () => "rejected";
		h.rejectError = "stale_generation";
		await flushOnce();
		await flushOnce();
		expect(h.ended).toEqual(["phone|s1"]);
	});

	test("a success in between resets the count", async () => {
		await h.publisher.follow(h.row());
		h.rejectError = "unknown_slot";
		h.outcome = () => "rejected";
		await flushOnce();
		h.outcome = () => "sent";
		await flushOnce();
		h.outcome = () => "rejected";
		await flushOnce();
		expect(h.ended).toEqual([]);
	});

	test("following with a new slot starts the count again", async () => {
		await h.publisher.follow(h.row("phone", "s1", "slot-1"));
		h.outcome = () => "rejected";
		h.rejectError = "unknown_slot";
		await flushOnce(); // one refusal of slot-1
		h.outcome = () => "budget_limited"; // neither a refusal-as-gone nor a success: leaves the count alone
		await h.publisher.follow(h.row("phone", "s1", "slot-2"));
		h.outcome = () => "rejected";
		await flushOnce(); // the first refusal of slot-2
		expect(h.ended).toEqual([]);
		await flushOnce();
		expect(h.ended).toEqual(["phone|s1"]);
	});

	test("following again with the same slot keeps the count", async () => {
		await h.publisher.follow(h.row("phone", "s1", "slot-1"));
		h.outcome = () => "rejected";
		h.rejectError = "unknown_slot";
		await flushOnce();
		h.outcome = () => "budget_limited";
		await h.publisher.follow(h.row("phone", "s1", "slot-1"));
		h.outcome = () => "rejected";
		await flushOnce();
		expect(h.ended).toEqual(["phone|s1"]);
	});

	test("other refusals never finish the row", async () => {
		await h.publisher.follow(h.row());
		h.outcome = () => "rejected";
		h.rejectError = "payload_too_large";
		for (let i = 0; i < 4; i++) await flushOnce();
		expect(h.ended).toEqual([]);
	});
});
