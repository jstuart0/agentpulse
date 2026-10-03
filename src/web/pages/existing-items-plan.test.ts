import { describe, expect, test } from "bun:test";
import {
	type ExistingResult,
	OWNER_CHOICE_PLACEHOLDER,
	existingSummaryText,
	idsKeptAsService,
	leaveUnassignedLabel,
	planExistingItems,
	settleExistingItems,
} from "./existing-items-plan.js";

describe("planExistingItems", () => {
	test("nothing chosen, nothing to do", () => {
		expect(planExistingItems({ claimSessionsFor: null, keys: {}, hosts: {} })).toEqual([]);
	});

	test("sessions first, then keys, then hosts, each only when someone was picked", () => {
		expect(
			planExistingItems({
				claimSessionsFor: "me",
				keys: { k1: { kind: "assign", userId: "u2" }, k2: { kind: "service" } },
				hosts: { h1: { kind: "assign", userId: "u3" } },
			}),
		).toEqual([
			{ kind: "claim-sessions", userId: "me" },
			{ kind: "assign-key", keyId: "k1", userId: "u2" },
			{ kind: "assign-host", hostId: "h1", userId: "u3" },
		]);
	});

	test("'assign to…' with nobody picked is skipped, never guessed", () => {
		expect(
			planExistingItems({
				claimSessionsFor: null,
				keys: { k1: { kind: "assign", userId: null } },
				hosts: { h1: { kind: "assign", userId: null }, h2: undefined },
			}),
		).toEqual([]);
	});

	test("keys are never assigned in bulk: each key is its own operation", () => {
		const ops = planExistingItems({
			claimSessionsFor: null,
			keys: { a: { kind: "assign", userId: "u2" }, b: { kind: "assign", userId: "u2" } },
			hosts: {},
		});
		expect(ops).toHaveLength(2);
	});
});

describe("idsKeptAsService", () => {
	test("the ids someone looked at and left as service keys", () => {
		expect(
			idsKeptAsService({
				a: { kind: "service" },
				b: { kind: "assign", userId: "u1" },
				c: { kind: "assign", userId: null },
				d: undefined,
			}),
		).toEqual(["a", "c"]);
	});
});

describe("planExistingItems and service keys", () => {
	test("a key left as a service key is written down when the server records it", () => {
		expect(
			planExistingItems({
				claimSessionsFor: null,
				keys: { k: { kind: "service" } },
				hosts: { h: { kind: "service" } },
				recordServiceKeys: true,
			}),
		).toEqual([{ kind: "mark-service-key", keyId: "k" }]);
	});

	test("a server that doesn't record it gets no write; hosts never do", () => {
		expect(
			planExistingItems({
				claimSessionsFor: null,
				keys: { k: { kind: "service" } },
				hosts: { h: { kind: "service" } },
				recordServiceKeys: false,
			}),
		).toEqual([]);
	});

	test("rows nobody touched produce nothing", () => {
		expect(
			planExistingItems({
				claimSessionsFor: null,
				keys: { k: undefined },
				hosts: {},
				recordServiceKeys: true,
			}),
		).toEqual([]);
	});
});

describe("settleExistingItems", () => {
	const names = { key: (id: string) => `key ${id}`, host: (id: string) => `host ${id}` };
	const ok = (op: ExistingResult["op"], extra: Partial<ExistingResult> = {}): ExistingResult => ({
		op,
		ok: true,
		...extra,
	});
	const input = {
		keyChoices: {},
		hostChoices: {},
		visibleKeyIds: ["k1", "k2", "k3"],
		visibleHostIds: ["h1"],
		names,
		recordServiceKeys: true,
	};

	test("two keys assigned, one left alone", () => {
		const result = settleExistingItems({
			...input,
			results: [
				ok({ kind: "assign-key", keyId: "k1", userId: "u" }),
				ok({ kind: "assign-key", keyId: "k2", userId: "u" }),
			],
			keyChoices: {
				k1: { kind: "assign", userId: "u" },
				k2: { kind: "assign", userId: "u" },
			},
		});
		expect(result.summary).toEqual({
			claimed: null,
			assignedKeys: 2,
			keptKeys: 0,
			assignedHosts: 0,
			keptHosts: 0,
			untouched: 2,
		});
		expect(result.failures).toEqual([]);
		expect(result.remainingKeyChoices).toEqual({});
	});

	test("a failed write stays chosen and is reported by name; the rest are cleared", () => {
		const result = settleExistingItems({
			...input,
			results: [
				ok({ kind: "assign-key", keyId: "k1", userId: "u" }),
				{
					op: { kind: "assign-key", keyId: "k2", userId: "u" },
					ok: false,
					message: "That person no longer exists.",
				},
			],
			keyChoices: {
				k1: { kind: "assign", userId: "u" },
				k2: { kind: "assign", userId: "u" },
			},
		});
		expect(result.failures).toEqual([
			{ label: "Assigning key k2", message: "That person no longer exists." },
		]);
		expect(result.remainingKeyChoices).toEqual({ k2: { kind: "assign", userId: "u" } });
		expect(result.summary.assignedKeys).toBe(1);
	});

	test("a claim that went through is done, even when a key after it failed: Try again must not send it again", () => {
		const result = settleExistingItems({
			...input,
			results: [
				ok({ kind: "claim-sessions", userId: "u" }, { claimed: 5 }),
				{ op: { kind: "assign-key", keyId: "k1", userId: "u" }, ok: false, message: "no" },
			],
			keyChoices: { k1: { kind: "assign", userId: "u" } },
		});
		expect(result.claimDone).toBe(true);
		expect(result.failures).toHaveLength(1);
		expect(Object.keys(result.remainingKeyChoices)).toEqual(["k1"]);
	});

	test("a claim that failed, or none at all, is not done", () => {
		expect(
			settleExistingItems({
				...input,
				results: [{ op: { kind: "claim-sessions", userId: "u" }, ok: false }],
			}).claimDone,
		).toBe(false);
		expect(settleExistingItems({ ...input, results: [] }).claimDone).toBe(false);
	});

	test("a failed claim and a failed host are labelled for what they were", () => {
		const result = settleExistingItems({
			...input,
			results: [
				{ op: { kind: "claim-sessions", userId: "me" }, ok: false, message: "x" },
				{ op: { kind: "assign-host", hostId: "h1", userId: "u" }, ok: false, message: "y" },
			],
			hostChoices: { h1: { kind: "assign", userId: "u" } },
		});
		expect(result.failures.map((f) => f.label)).toEqual([
			"Assigning past sessions",
			"Assigning host h1",
		]);
		expect(result.remainingHostChoices).toEqual({ h1: { kind: "assign", userId: "u" } });
		expect(result.summary.claimed).toBeNull();
	});

	test("sessions claimed are counted; hosts left unassigned are counted but never remembered", () => {
		const result = settleExistingItems({
			...input,
			results: [ok({ kind: "claim-sessions", userId: "me" }, { claimed: 214 })],
			hostChoices: { h1: { kind: "service" } },
		});
		expect(result.summary.claimed).toBe(214);
		expect(result.summary.keptHosts).toBe(1);
		expect("reviewedHostIds" in result).toBe(false);
		expect(result.summary.untouched).toBe(3);
	});

	test("a key kept as a service key is counted; it is remembered here only when the server doesn't record it", () => {
		const recorded = settleExistingItems({
			...input,
			results: [ok({ kind: "mark-service-key", keyId: "k1" })],
			keyChoices: { k1: { kind: "service" } },
		});
		expect(recorded.summary.keptKeys).toBe(1);
		expect(recorded.reviewedKeyIds).toEqual([]);

		const notRecorded = settleExistingItems({
			...input,
			recordServiceKeys: false,
			results: [],
			keyChoices: { k1: { kind: "service" } },
		});
		expect(notRecorded.summary.keptKeys).toBe(1);
		expect(notRecorded.reviewedKeyIds).toEqual(["k1"]);
	});

	test("a key whose write failed isn't remembered as reviewed", () => {
		const result = settleExistingItems({
			...input,
			results: [{ op: { kind: "mark-service-key", keyId: "k1" }, ok: false, message: "no" }],
			keyChoices: { k1: { kind: "service" } },
		});
		expect(result.summary.keptKeys).toBe(0);
		expect(result.remainingKeyChoices).toEqual({ k1: { kind: "service" } });
	});

	test("untouched selects count as left unchanged", () => {
		const result = settleExistingItems({ ...input, results: [] });
		expect(result.summary.untouched).toBe(4);
	});
});

describe("existingSummaryText", () => {
	const none = {
		claimed: null,
		assignedKeys: 0,
		keptKeys: 0,
		assignedHosts: 0,
		keptHosts: 0,
		untouched: 0,
	};

	test("says exactly what happened and what was left alone", () => {
		expect(existingSummaryText({ ...none, assignedKeys: 2, untouched: 1 })).toBe(
			"Assigned 2 keys. Left 1 unchanged.",
		);
	});

	test("nothing touched is 'Nothing changed.' whatever was left", () => {
		expect(existingSummaryText(none)).toBe("Nothing changed.");
		expect(existingSummaryText({ ...none, untouched: 3 })).toBe("Nothing changed.");
	});

	test("every kind of change, singular and plural", () => {
		expect(
			existingSummaryText({
				claimed: 1,
				assignedKeys: 1,
				keptKeys: 1,
				assignedHosts: 2,
				keptHosts: 1,
				untouched: 0,
			}),
		).toBe(
			"1 session is now yours. Assigned 1 key. Kept 1 key as a service key. Assigned 2 hosts. Left 1 host unassigned.",
		);
		expect(existingSummaryText({ ...none, claimed: 214 })).toBe("214 sessions are now yours.");
	});
});

describe("labels", () => {
	test("rows start on a placeholder; leaving a row is worded per kind", () => {
		expect(OWNER_CHOICE_PLACEHOLDER).toBe("");
		expect(leaveUnassignedLabel("key")).toBe("Keep as a service key");
		expect(leaveUnassignedLabel("host")).toBe("Leave unassigned");
	});
});
