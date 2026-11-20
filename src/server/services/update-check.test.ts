/**
 * The server's update check, through the `ManifestSource` port. Most cases use the fixture source and the
 * throwaway test signing key; the real https adapter is exercised against a local TLS server at the bottom.
 * There is no network here.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOW,
	TEST_KEYS,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
	testRelease,
} from "../../shared/__fixtures__/release-test-signer.js";
import { RELEASE_KEYS } from "../../shared/release-keys.js";
import type { LastSeen } from "../../shared/release-manifest.js";
import {
	EMPTY_STORED,
	fixtureSource,
	manualScheduler,
	memoryUpdateStore,
} from "../test-utils/update-fixtures.js";
import {
	MANIFEST_URL,
	type UpdateCheckDeps,
	createHttpsManifestSource,
	createHttpsManifestSourceForTests,
	createUpdateChecker,
	updateCheckEnabled,
} from "./update-check.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(over: Partial<UpdateCheckDeps> = {}, stored = EMPTY_STORED) {
	const clock = { now: NOW };
	const scheduler = manualScheduler();
	const store = memoryUpdateStore(stored);
	const source = fixtureSource();
	const logs: string[] = [];
	const deps: UpdateCheckDeps = {
		source,
		store,
		keys: TEST_KEY_LIST,
		currentVersion: "0.11.0",
		install: () => ({ kind: "local", track: "release" }),
		enabled: () => true,
		now: () => clock.now,
		random: () => 0.5,
		schedule: scheduler.schedule,
		log: (line) => logs.push(line),
		...over,
	};
	const checker = createUpdateChecker(deps);
	return { checker, clock, scheduler, store, source: deps.source as typeof source, logs, deps };
}

/** Starts the checker and fires its first timer, waiting for the check to finish. */
async function runScheduled(t: ReturnType<typeof setup>): Promise<number> {
	const delay = t.scheduler.fire();
	await t.checker.whenIdle();
	t.clock.now += delay;
	return delay;
}

const good = (over = {}) => envelopeFor(testPayload(over));

describe("status from a verified manifest", () => {
	test("before any check: no manifest, nothing claimed, state unverified", async () => {
		const t = setup();
		t.checker.start();
		await t.checker.whenReady();
		const status = t.checker.status();
		expect(status).toMatchObject({
			current: "0.11.0",
			latest: null,
			state: "unverified",
			stale: false,
			checkedAt: null,
			lastResult: null,
			manifestIssuedAt: null,
			installKind: "local",
			track: "release",
			localApply: null,
		});
		expect(t.checker.envelope()).toBeNull();
	});

	test("a good check: available, latest, severity, check time, and the envelope is kept as served", async () => {
		const text = good();
		const t = setup();
		t.source.push(text);
		const status = await t.checker.checkNow();
		expect(status).toMatchObject({
			state: "available",
			latest: "0.12.0",
			severity: "normal",
			stale: false,
			lastResult: "ok",
			manifestIssuedAt: "2026-11-19T11:00:00.000Z",
			checkedAt: new Date(NOW).toISOString(),
		});
		expect(t.checker.envelope()).toBe(text);
		const stored = t.store.snapshot();
		expect(stored.envelope).toBe(text);
		expect(stored.state.last).toMatchObject({ seq: 100, issuedAt: "2026-11-19T11:00:00.000Z" });
		expect(stored.state.last?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test("each state the manifest can produce reaches the status", async () => {
		const cases: Array<[string, string, Parameters<typeof testPayload>[0]]> = [
			["available", "0.11.0", {}],
			["current", "0.12.0", {}],
			[
				"security",
				"0.11.0",
				{ releases: [testRelease("0.12.0", { severity: "security" }), testRelease("0.11.0")] },
			],
			[
				"current_pulled",
				"0.11.0",
				{ releases: [testRelease("0.12.0"), testRelease("0.11.0", { pulled: true })] },
			],
			["below_minimum", "0.10.0", { minSupported: "0.11.0" }],
		];
		for (const [state, current, over] of cases) {
			const t = setup({ currentVersion: current });
			t.source.push(good(over));
			expect((await t.checker.checkNow()).state).toBe(state as never);
		}
	});

	test("a security release marks severity security even when latest is normal", async () => {
		const t = setup();
		t.source.push(
			good({
				releases: [
					testRelease("0.12.1"),
					testRelease("0.12.0", { severity: "security" }),
					testRelease("0.11.0"),
				],
				latest: "0.12.1",
			}),
		);
		const status = await t.checker.checkNow();
		expect(status.state).toBe("security");
		expect(status.severity).toBe("security");
		expect(status.latest).toBe("0.12.1");
	});

	test("with the check switched off the state is disabled and nothing is fetched", async () => {
		const t = setup({ enabled: () => false });
		t.source.push(good());
		t.checker.start();
		await t.checker.whenReady();
		expect(t.scheduler.scheduled).toHaveLength(0);
		const status = await t.checker.checkNow();
		expect(status.state).toBe("disabled");
		expect(status.latest).toBeNull();
		expect(t.source.fetches).toBe(0);
		expect(t.checker.envelope()).toBeNull();
	});

	test("flipping the switch off after start stops the next fetch", async () => {
		let on = true;
		const t = setup({ enabled: () => on });
		t.source.push(good());
		t.checker.start();
		await t.checker.whenReady();
		on = false;
		t.scheduler.fire();
		await t.checker.whenIdle();
		expect(t.source.fetches).toBe(0);
		expect(t.checker.status().state).toBe("disabled");
	});
});

describe("the empty production key list", () => {
	test("a manifest nobody can verify leaves every install on unverified, whatever it says", async () => {
		expect(RELEASE_KEYS).toHaveLength(0);
		const t = setup({ keys: RELEASE_KEYS });
		t.source.push(good());
		const status = await t.checker.checkNow();
		expect(status.state).toBe("unverified");
		expect(status.latest).toBeNull();
		expect(status.lastResult).toBe("not_published");
		expect(t.source.fetches).toBe(0);
		expect(t.logs).toHaveLength(0);
		expect(t.checker.envelope()).toBeNull();
		expect(t.store.snapshot().envelope).toBeNull();
	});
});

describe("nothing published yet is its own signal, and a quiet one", () => {
	test("a 404 from the feed is not_published: no log, no backoff, state unverified", async () => {
		const t = setup();
		t.source.push({ fail: "status", status: 404 });
		t.checker.start();
		await runScheduled(t);
		expect(t.checker.status()).toMatchObject({ state: "unverified", lastResult: "not_published" });
		expect(t.logs).toHaveLength(0);
		expect(t.scheduler.nextDelay()).toBe(DAY);
	});

	test("a 500 is still unreachable, logged and backed off", async () => {
		const t = setup();
		t.source.push({ fail: "status", status: 503 });
		t.checker.start();
		await runScheduled(t);
		expect(t.checker.status().lastResult).toBe("unreachable");
		expect(t.logs).toHaveLength(1);
		expect(t.scheduler.nextDelay()).toBe(HOUR);
	});

	test("an empty key list never fetches: nothing could be verified", async () => {
		const t = setup({ keys: [] });
		t.source.push(good());
		t.checker.start();
		await runScheduled(t);
		expect(t.source.fetches).toBe(0);
		expect(t.checker.status().lastResult).toBe("not_published");
		expect(t.scheduler.nextDelay()).toBe(DAY);
	});

	test("a 404 after a good manifest was held leaves its state in place", async () => {
		const t = setup();
		t.source.push(good());
		await t.checker.checkNow();
		t.source.push({ fail: "status", status: 404 });
		const status = await t.checker.checkNow();
		expect(status).toMatchObject({ state: "available", lastResult: "not_published" });
	});
});

describe("unreachable and stale are representations, not states", () => {
	test("a failed fetch with nothing stored: state unverified, lastResult unreachable, the time recorded", async () => {
		const t = setup();
		t.source.push({ fail: "network" });
		const status = await t.checker.checkNow();
		expect(status).toMatchObject({
			state: "unverified",
			lastResult: "unreachable",
			checkedAt: new Date(NOW).toISOString(),
		});
	});

	test("a failed fetch with a good manifest held leaves its state in place", async () => {
		const t = setup();
		t.source.push(good());
		await t.checker.checkNow();
		t.source.push({ fail: "timeout" });
		const status = await t.checker.checkNow();
		expect(status).toMatchObject({
			state: "available",
			latest: "0.12.0",
			lastResult: "unreachable",
		});
	});

	test("stale is a field of its own: it turns on when the manifest's time passes, with no refetch, and the state stays", async () => {
		const t = setup();
		t.source.push(good());
		await t.checker.checkNow();
		expect(t.checker.status().stale).toBe(false);
		t.clock.now = Date.parse("2026-11-29T11:00:01.000Z");
		const status = t.checker.status();
		expect(status.stale).toBe(true);
		expect(status.state).toBe("available");
	});

	test("a manifest that is already stale when fetched verifies, shows as stale and is kept", async () => {
		const t = setup();
		t.clock.now = Date.parse("2026-12-05T00:00:00.000Z");
		t.source.push(good());
		const status = await t.checker.checkNow();
		expect(status).toMatchObject({ state: "available", stale: true, lastResult: "ok" });
		expect(t.checker.envelope()).not.toBeNull();
	});
});

describe("a manifest that is not newer than what we hold", () => {
	async function holding() {
		const t = setup();
		t.source.push(good());
		await t.checker.checkNow();
		return t;
	}

	for (const [label, text, result] of [
		["an older seq", () => good({ seq: 99 }), "replayed"],
		["the same seq issued earlier", () => good({ issuedAt: "2026-11-19T10:00:00.000Z" }), "older"],
	] as const) {
		test(`${label} (${result}) changes nothing and is never unverified`, async () => {
			const t = await holding();
			const before = t.store.snapshot();
			const envelopeBefore = t.checker.envelope();
			const statusBefore = t.checker.status();
			t.source.push(text());
			const status = await t.checker.checkNow();
			expect(status.lastResult).toBe(result);
			expect(status.state).toBe(statusBefore.state);
			expect(status.state).not.toBe("unverified");
			expect(status.latest).toBe(statusBefore.latest);
			expect(status.manifestIssuedAt).toBe(statusBefore.manifestIssuedAt);
			expect(t.checker.envelope()).toBe(envelopeBefore);
			const after = t.store.snapshot();
			expect(after.envelope).toBe(before.envelope);
			expect(after.state.last).toEqual(before.state.last as LastSeen);
			expect(after.state.revoked).toEqual(before.state.revoked);
		});
	}

	test("replay and older don't back the schedule off: they aren't failures", async () => {
		const t = await holding();
		t.checker.start();
		await t.checker.whenReady();
		t.source.push(good({ seq: 99 }));
		await runScheduled(t);
		expect(t.scheduler.nextDelay()).toBe(DAY);
	});
});

describe("a check that fails verification moves nothing", () => {
	const failing: Array<[string, () => string, string]> = [
		["a bad signature", () => good().replace(/"sig":"./, '"sig":"A'), "bad_signature"],
		["an unknown signer", () => envelopeFor(testPayload(), "unknown"), "unknown_key"],
		["garbage", () => "not json", "bad_envelope"],
		["a bad payload", () => envelopeFor({ ...testPayload(), schema: 2 }), "bad_payload"],
		[
			"an issue time far ahead",
			() =>
				good({
					seq: 200,
					issuedAt: "2026-12-30T00:00:00.000Z",
					expiresAt: "2027-01-05T00:00:00.000Z",
				}),
			"future",
		],
	];
	for (const [label, text, code] of failing) {
		test(`${label} (${code}): envelope, last, revoked and the displayed state are exactly as before`, async () => {
			const t = setup();
			t.source.push(good());
			await t.checker.checkNow();
			const before = t.store.snapshot();
			const statusBefore = t.checker.status();
			t.source.push(text());
			const status = await t.checker.checkNow();
			expect(status.lastResult).toBe(code as never);
			expect(status.state).toBe(statusBefore.state);
			expect(status.latest).toBe(statusBefore.latest);
			const after = t.store.snapshot();
			expect(after.envelope).toBe(before.envelope);
			expect(after.state.last).toEqual(before.state.last as LastSeen);
			expect(after.state.revoked).toEqual(before.state.revoked);
			// Nothing the verifier would have ratcheted was written: no save carries a different `last`.
			for (const save of t.store.saves) {
				if (save.state) expect(save.state.last).toEqual(before.state.last as LastSeen);
			}
		});
	}

	test("with nothing held, a failed verify leaves last and revoked empty", async () => {
		const t = setup();
		t.source.push(envelopeFor(testPayload(), "unknown"));
		await t.checker.checkNow();
		expect(t.store.snapshot().state.last).toBeNull();
		expect(t.store.snapshot().state.revoked).toEqual([]);
	});
});

describe("revocation memory", () => {
	const revoking = () =>
		envelopeFor(testPayload({ seq: 101, revokedKeyIds: [TEST_KEYS.active.keyId] }), "standby");

	test("the union the verifier returns is persisted", async () => {
		const t = setup();
		t.source.push(revoking());
		await t.checker.checkNow();
		expect(t.store.snapshot().state.revoked).toEqual([TEST_KEYS.active.keyId]);
	});

	test("it is applied to the next fetch in the same run: the revoked key's envelope is refused", async () => {
		const t = setup();
		t.source.push(revoking());
		await t.checker.checkNow();
		t.source.push(good({ seq: 102 }));
		const status = await t.checker.checkNow();
		expect(status.lastResult).toBe("revoked_key");
		expect(status.manifestIssuedAt).toBe("2026-11-19T11:00:00.000Z");
		expect(t.store.snapshot().state.last?.seq).toBe(101);
	});

	test("it is re-applied when the stored envelope is re-verified at boot", async () => {
		const first = setup();
		first.source.push(revoking());
		await first.checker.checkNow();
		const stored = first.store.snapshot();

		const second = setup({}, stored);
		second.checker.start();
		await second.checker.whenReady();
		// The standby-signed envelope still verifies; the memory of the revoked key survives the restart.
		expect(second.checker.envelope()).not.toBeNull();
		second.source.push(good({ seq: 102 }));
		expect((await second.checker.checkNow()).lastResult).toBe("revoked_key");
		expect(second.store.snapshot().state.revoked).toEqual([TEST_KEYS.active.keyId]);
	});

	test("an envelope signed by a key revoked since it was stored is dropped at boot and not served", async () => {
		const first = setup();
		first.source.push(good());
		await first.checker.checkNow();
		const stored = first.store.snapshot();
		stored.state.revoked = [TEST_KEYS.active.keyId];

		const second = setup({}, stored);
		second.checker.start();
		await second.checker.whenReady();
		expect(second.checker.envelope()).toBeNull();
		expect(second.checker.status().state).toBe("unverified");
		expect(second.store.snapshot().envelope).toBeNull();
		// The replay memory is kept even though the envelope is gone.
		expect(second.store.snapshot().state.last?.seq).toBe(100);
	});
});

describe("boot: the stored envelope is re-verified, not trusted", () => {
	test("a good stored envelope is served from memory at once, before any fetch", async () => {
		const first = setup();
		first.source.push(good());
		await first.checker.checkNow();
		const second = setup({}, first.store.snapshot());
		second.checker.start();
		await second.checker.whenReady();
		expect(second.checker.status()).toMatchObject({ state: "available", latest: "0.12.0" });
		expect(second.checker.envelope()).toBe(first.checker.envelope());
		expect(second.source.fetches).toBe(0);
	});

	test("one that no longer verifies is dropped and not served", async () => {
		const stored = {
			envelope: envelopeFor(testPayload(), "unknown"),
			state: {
				...EMPTY_STORED.state,
				last: { seq: 100, issuedAt: "2026-11-19T11:00:00.000Z", fingerprint: "a".repeat(64) },
			},
		};
		const t = setup({}, stored);
		t.checker.start();
		await t.checker.whenReady();
		expect(t.checker.envelope()).toBeNull();
		expect(t.checker.status().state).toBe("unverified");
		expect(t.store.snapshot().envelope).toBeNull();
	});

	test("an unparseable stored envelope is dropped the same way", async () => {
		const t = setup({}, { envelope: "{{", state: EMPTY_STORED.state });
		t.checker.start();
		await t.checker.whenReady();
		expect(t.checker.envelope()).toBeNull();
	});

	test("a stored envelope past its expiry still loads, as stale", async () => {
		const first = setup();
		first.source.push(good());
		await first.checker.checkNow();
		const second = setup({}, first.store.snapshot());
		second.clock.now = Date.parse("2026-12-20T00:00:00.000Z");
		second.checker.start();
		await second.checker.whenReady();
		expect(second.checker.status()).toMatchObject({ state: "available", stale: true });
	});
});

describe("schedule and backoff", () => {
	test("the first check comes 60 to 300 seconds after start", async () => {
		const low = setup({ random: () => 0 });
		low.checker.start();
		expect(low.scheduler.nextDelay()).toBe(60_000);
		const high = setup({ random: () => 0.999999 });
		high.checker.start();
		const delay = high.scheduler.nextDelay() as number;
		expect(delay).toBeGreaterThan(299_000);
		expect(delay).toBeLessThanOrEqual(300_000);
	});

	test("success waits 24 hours; failures wait 1 hour, 6 hours, then 24 hours; a success resets", async () => {
		const t = setup();
		t.source.push(
			{ fail: "network" },
			{ fail: "network" },
			{ fail: "network" },
			{ fail: "network" },
			good(),
		);
		t.checker.start();
		const delays: number[] = [];
		for (let i = 0; i < 5; i++) {
			await runScheduled(t);
			delays.push(t.scheduler.nextDelay() as number);
		}
		expect(delays).toEqual([HOUR, 6 * HOUR, DAY, DAY, DAY]);
		t.source.push({ fail: "status" });
		await runScheduled(t);
		expect(t.scheduler.nextDelay()).toBe(HOUR);
	});

	test("stop cancels the timer", () => {
		const t = setup();
		const stop = t.checker.start();
		stop();
		expect(t.scheduler.nextDelay()).toBeNull();
	});

	test("a week without a network: a bounded number of fetches and no more than one log line a day", async () => {
		const t = setup();
		t.source.push({ fail: "network" });
		t.checker.start();
		const end = NOW + 7 * DAY;
		while (t.clock.now < end) await runScheduled(t);
		expect(t.source.fetches).toBeLessThanOrEqual(10);
		expect(t.logs.length).toBeGreaterThanOrEqual(1);
		expect(t.logs.length).toBeLessThanOrEqual(7);
		for (const line of t.logs) expect(line).toMatch(/^\[update-check\] check failed: [a-z_]+$/);
		// Never a banner-worthy state: the install just reads as one that can't verify.
		expect(t.checker.status().state).toBe("unverified");
	});

	test("a week of good checks is about one fetch a day", async () => {
		const t = setup();
		t.source.push(good());
		t.checker.start();
		const end = NOW + 7 * DAY;
		while (t.clock.now < end) await runScheduled(t);
		expect(t.source.fetches).toBeLessThanOrEqual(8);
		expect(t.source.fetches).toBeGreaterThanOrEqual(6);
		expect(t.logs).toHaveLength(0);
	});
});

describe("boot never stops the timer", () => {
	test("a store whose load throws: the check still runs from empty state and reschedules", async () => {
		const store = memoryUpdateStore();
		store.load = async () => {
			throw new Error("db not ready");
		};
		const t = setup({ store });
		t.source.push(good());
		t.checker.start();
		await t.checker.whenReady();
		await runScheduled(t);
		expect(t.checker.status().state).toBe("available");
		expect(t.scheduler.nextDelay()).toBe(DAY);
	});

	test("a load that rejects outright is caught: one fixed log line, whenReady resolves, the timer reschedules", async () => {
		const store = memoryUpdateStore({ envelope: good(), state: EMPTY_STORED.state });
		let broken = true;
		const keys = Object.assign([...TEST_KEY_LIST], {
			map(...args: unknown[]) {
				if (broken) throw new Error("keys unreadable");
				return Array.prototype.map.apply(this, args as never);
			},
		}) as unknown as typeof TEST_KEY_LIST;
		const t = setup({ store, keys });
		t.checker.start();
		await t.checker.whenReady();
		expect(t.logs).toEqual(["[update-check] check failed: boot_failed"]);
		broken = false;
		t.source.push({ fail: "network" });
		await runScheduled(t);
		expect(t.scheduler.nextDelay()).toBe(HOUR);
	});
});

describe("two replicas sharing one store merge, never overwrite", () => {
	test("a replica that holds an older manifest cannot rewind last, revoked or the envelope", async () => {
		const store = memoryUpdateStore();
		const a = setup({ store });
		const b = setup({ store });
		a.source.push(good());
		await a.checker.checkNow();
		const revoking = envelopeFor(
			testPayload({ seq: 101, revokedKeyIds: [TEST_KEYS.active.keyId] }),
			"standby",
		);
		b.source.push(revoking);
		await b.checker.checkNow();
		// A still holds seq 100 in memory and checks again later.
		a.clock.now += HOUR;
		await a.checker.checkNow();
		const stored = store.snapshot();
		expect(stored.state.last?.seq).toBe(101);
		expect(stored.state.revoked).toEqual([TEST_KEYS.active.keyId]);
		expect(stored.envelope).toBe(revoking);
		expect(stored.state.lastCheckedAt).toBe(new Date(NOW + HOUR).toISOString());
	});

	test("the newer lastCheckedAt wins, and the merged replay memory is adopted in memory", async () => {
		const store = memoryUpdateStore();
		const a = setup({ store });
		const b = setup({ store });
		b.clock.now = NOW + 5 * HOUR;
		b.source.push(good({ seq: 105 }));
		await b.checker.checkNow();
		a.source.push(good({ seq: 103 }));
		await a.checker.checkNow();
		expect(store.snapshot().state.last?.seq).toBe(105);
		expect(store.snapshot().state.lastCheckedAt).toBe(new Date(NOW + 5 * HOUR).toISOString());
		// Having merged, A now refuses what 105 already superseded.
		a.clock.now = NOW + 6 * HOUR;
		a.source.push(good({ seq: 104 }));
		expect((await a.checker.checkNow()).lastResult).toBe("replayed");
	});
});

describe("it never throws into its caller", () => {
	test("a source that throws", async () => {
		const t = setup({
			source: {
				fetchEnvelope: async () => {
					throw new Error("boom");
				},
			},
		});
		const status = await t.checker.checkNow();
		expect(status.lastResult).toBe("unreachable");
		expect(t.logs).toHaveLength(1);
		expect(t.logs[0]).not.toContain("boom");
	});

	test("a store that fails to write", async () => {
		const store = memoryUpdateStore();
		store.save = async () => {
			throw new Error("disk full");
		};
		const t = setup({ store });
		t.source.push(good());
		const status = await t.checker.checkNow();
		expect(status.state).toBe("available");
		expect(t.logs.some((l) => l.includes("disk full"))).toBe(false);
	});

	test("two concurrent manual checks share one fetch", async () => {
		const t = setup();
		t.source.push(good());
		await Promise.all([t.checker.checkNow(), t.checker.checkNow()]);
		expect(t.source.fetches).toBe(1);
	});
});

describe("the off switch is its own switch", () => {
	test("AGENTPULSE_UPDATE_CHECK off, false or 0 turns the check off, in any case", () => {
		for (const v of ["off", "OFF", "false", "False", "0", " off "]) {
			expect(updateCheckEnabled({ AGENTPULSE_UPDATE_CHECK: v })).toBe(false);
		}
	});

	test("anything else, and an unset variable, leaves it on", () => {
		for (const v of [undefined, "", "on", "1", "true", "yes"]) {
			expect(updateCheckEnabled({ AGENTPULSE_UPDATE_CHECK: v })).toBe(true);
		}
	});

	test("telemetry's switches don't turn it off: DO_NOT_TRACK=1 and AGENTPULSE_TELEMETRY=off still fetch", async () => {
		const env = { DO_NOT_TRACK: "1", AGENTPULSE_TELEMETRY: "off" };
		expect(updateCheckEnabled(env)).toBe(true);
		const t = setup({ enabled: () => updateCheckEnabled(env) });
		t.source.push(good());
		await t.checker.checkNow();
		expect(t.source.fetches).toBe(1);
	});
});

// ── The real https adapter, against a local TLS server ─────────────────────────────────────

describe("the https adapter", () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-update-check-"));
	let cert = "";
	let tlsServer: ReturnType<typeof Bun.serve>;
	let plainServer: ReturnType<typeof Bun.serve>;
	let otherServer: ReturnType<typeof Bun.serve>;
	let otherHits = 0;
	let plainHits = 0;
	const seen: Request[] = [];
	let servedEnvelope = "";
	const url = (path = "/releases/manifest.json") => `https://127.0.0.1:${tlsServer.port}${path}`;
	const source = (path?: string, deadlineMs?: number) =>
		createHttpsManifestSourceForTests({ url: url(path), ca: cert, deadlineMs });

	// The suite's setup shells out to openssl: under a loaded full run the default 5 s hook limit expired, the TLS
	// server never started, and every test below failed on "network". An EC key is quick, and the limit is generous.
	// These tests talk to servers on 127.0.0.1. Another test file may have set a proxy variable (scripts/claude-live-safety
	// sets HTTPS_PROXY on purpose and restores it, and Bun can keep what it read), which would send every request to a
	// proxy that doesn't exist: loopback is exempted for the whole suite so run order can't matter.
	const savedProxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
	beforeAll(async () => {
		process.env.NO_PROXY = "127.0.0.1,localhost,[::1]";
		process.env.no_proxy = process.env.NO_PROXY;
		const key = join(dir, "key.pem");
		const crt = join(dir, "cert.pem");
		const made = Bun.spawnSync([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-keyout",
			key,
			"-out",
			crt,
			"-days",
			"2",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		]);
		if (made.exitCode !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`);
		cert = await Bun.file(crt).text();
		otherServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				otherHits++;
				return new Response("other");
			},
		});
		plainServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				plainHits++;
				return new Response(servedEnvelope);
			},
		});
		tlsServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert, key: await Bun.file(key).text() },
			fetch(req) {
				seen.push(req);
				const path = new URL(req.url).pathname;
				if (path === "/releases/manifest.json") return new Response(servedEnvelope);
				if (path === "/cap") return new Response("a".repeat(32 * 1024));
				if (path === "/over") return new Response("a".repeat(32 * 1024 + 1));
				if (path === "/redirect")
					return new Response(null, {
						status: 302,
						headers: { location: `http://127.0.0.1:${otherServer.port}/x` },
					});
				if (path === "/500") return new Response("no", { status: 503 });
				if (path === "/drip") {
					return new Response(
						new ReadableStream({
							async start(controller) {
								for (let i = 0; i < 100; i++) {
									controller.enqueue(new TextEncoder().encode("x"));
									await Bun.sleep(50);
								}
								controller.close();
							},
						}),
					);
				}
				return new Response("nope", { status: 404 });
			},
		});
	}, 120_000);
	afterAll(() => {
		for (const [name, value] of Object.entries(savedProxy)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		tlsServer.stop(true);
		plainServer.stop(true);
		otherServer.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a plain GET: no cookie, no query string, no custom headers, no conditional request", async () => {
		servedEnvelope = good();
		seen.length = 0;
		const result = await source().fetchEnvelope();
		expect(result).toEqual({ ok: true, body: servedEnvelope });
		expect(seen).toHaveLength(1);
		const request = seen[0];
		expect(request.method).toBe("GET");
		expect(new URL(request.url).search).toBe("");
		for (const name of [
			"cookie",
			"authorization",
			"if-none-match",
			"if-modified-since",
			"referer",
			"origin",
		]) {
			expect(request.headers.has(name)).toBe(false);
		}
		for (const [name] of request.headers) expect(name.startsWith("x-")).toBe(false);
	});

	test("a 302 to another origin is refused and that origin gets no request", async () => {
		otherHits = 0;
		const result = await source("/redirect").fetchEnvelope();
		expect(result).toEqual({ ok: false, code: "redirect", status: 302 });
		expect(otherHits).toBe(0);
	});

	test("32 KiB is accepted and 32 KiB plus one byte is refused", async () => {
		const ok = await source("/cap").fetchEnvelope();
		expect(ok.ok).toBe(true);
		expect(await source("/over").fetchEnvelope()).toEqual({ ok: false, code: "too_large" });
	});

	test("a slow drip hits the deadline", async () => {
		const started = Date.now();
		const result = await source("/drip", 300).fetchEnvelope();
		expect(result).toEqual({ ok: false, code: "timeout" });
		expect(Date.now() - started).toBeLessThan(3000);
	});

	test("a 5xx is a refusal that backs the checker off an hour", async () => {
		const t = setup({ source: source("/500") });
		t.checker.start();
		await runScheduled(t);
		expect(t.scheduler.nextDelay()).toBe(HOUR);
		expect(t.checker.status().lastResult).toBe("unreachable");
	});

	test("http:// is refused before any request, even to loopback", async () => {
		plainHits = 0;
		const refused = createHttpsManifestSourceForTests({
			url: `http://127.0.0.1:${plainServer.port}/m`,
		});
		expect(await refused.fetchEnvelope()).toEqual({ ok: false, code: "insecure" });
		expect(plainHits).toBe(0);
	});

	test("an untrusted certificate is a failure, not a success", async () => {
		const noCa = createHttpsManifestSourceForTests({ url: url() });
		const result = await noCa.fetchEnvelope();
		expect(result.ok).toBe(false);
	});

	test("the default adapter asks for exactly the pinned URL, with no options beyond a bare GET", async () => {
		const spy = spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response("{}")) as never,
		);
		try {
			await createHttpsManifestSource().fetchEnvelope();
			expect(spy).toHaveBeenCalledTimes(1);
			const [calledUrl, init] = spy.mock.calls[0] as [string, RequestInit & { tls?: unknown }];
			expect(calledUrl).toBe(MANIFEST_URL);
			expect(MANIFEST_URL).toBe("https://jstuart0.github.io/agentpulse/releases/manifest.json");
			expect(init.redirect).toBe("manual");
			expect(init.headers).toBeUndefined();
			expect(init.credentials).toBeUndefined();
			expect(init.tls).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});

	test("end to end: a signed envelope from the TLS server becomes an available update", async () => {
		servedEnvelope = good();
		const t = setup({ source: source() });
		const status = await t.checker.checkNow();
		expect(status).toMatchObject({ state: "available", latest: "0.12.0", lastResult: "ok" });
	});
});
