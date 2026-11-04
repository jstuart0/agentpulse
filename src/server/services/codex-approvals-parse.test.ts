/**
 * The strict parsers for the two supervisor messages (D17). They copy only the
 * named fields, so nothing a sender adds reaches a row, and refuse an unknown
 * `v`, an unknown enum value or anything over a cap.
 */
import { describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import {
	CODEX_APPROVAL_LIMITS,
	NOT_APPROVABLE_REASONS,
	TRACKER_OUTCOMES,
} from "../../shared/codex-approvals.js";

const { parseApprovalReport, parseApprovalSync } = await import("./codex-approvals.js");

const report = (over: Record<string, unknown> = {}) => ({
	v: 1,
	runtimeEpoch: "epoch",
	rpcId: "7",
	requestKind: "command",
	threadId: "t",
	turnId: "u",
	itemId: "i",
	providerApprovalId: null,
	ageMs: 12,
	revision: 1,
	command: "npm test",
	cwd: "/work",
	reason: null,
	grantRoot: null,
	truncated: false,
	declineOnly: [],
	...over,
});

describe("parseApprovalReport", () => {
	test("a well-formed report parses to exactly the named fields", () => {
		const parsed = parseApprovalReport({ ...report(), secretExtra: "x", agentpulse_internal: 1 });
		expect(parsed).not.toBeNull();
		expect(Object.keys(parsed ?? {}).sort()).toEqual(
			[
				"v",
				"runtimeEpoch",
				"rpcId",
				"requestKind",
				"threadId",
				"turnId",
				"itemId",
				"providerApprovalId",
				"ageMs",
				"revision",
				"command",
				"cwd",
				"reason",
				"grantRoot",
				"changes",
				"truncated",
				"declineOnly",
			].sort(),
		);
		expect(JSON.stringify(parsed)).not.toContain("secretExtra");
	});

	test("a file change with its changes parses, and an entry is copied by allowlist", () => {
		const parsed = parseApprovalReport(
			report({
				requestKind: "file_change",
				command: undefined,
				changes: [{ path: "/work/a", kind: "add", movePath: null, diff: "+x\n", extra: "no" }],
			}),
		);
		expect(parsed?.changes).toEqual([
			{ path: "/work/a", kind: "add", movePath: null, diff: "+x\n" },
		]);
	});

	test("anything malformed is refused", () => {
		const bad: Array<[string, unknown]> = [
			["not an object", "x"],
			["an array", []],
			["null", null],
			["unknown v", report({ v: 2 })],
			["missing v", report({ v: undefined })],
			["unknown kind", report({ requestKind: "permissions" })],
			["empty epoch", report({ runtimeEpoch: "" })],
			["epoch too long", report({ runtimeEpoch: "e".repeat(129) })],
			["rpc id not a string", report({ rpcId: 7 })],
			["ageMs not a number", report({ ageMs: "12" })],
			["revision float", report({ revision: 1.5 })],
			["revision negative", report({ revision: -1 })],
			["truncated not boolean", report({ truncated: "no" })],
			["declineOnly not an array", report({ declineOnly: "network" })],
			["declineOnly unknown value", report({ declineOnly: ["bogus"] })],
			[
				"declineOnly too long",
				report({ declineOnly: Array(NOT_APPROVABLE_REASONS.length + 1).fill("network") }),
			],
			["command not a string", report({ command: 42 })],
			["changes not an array", report({ changes: {} })],
			["too many changes", report({ changes: Array(1001).fill({ path: "/a", kind: "add" }) })],
			["a change that isn't an object", report({ changes: ["x"] })],
			["a change with a numeric path", report({ changes: [{ path: 1, kind: "add" }] })],
			[
				"a text field over the body cap",
				report({ command: "x".repeat(CODEX_APPROVAL_LIMITS.reportBodyBytes + 1) }),
			],
		];
		for (const [label, body] of bad) expect(parseApprovalReport(body), label).toBeNull();
	});
});

describe("parseApprovalSync", () => {
	const sync = (over: Record<string, unknown> = {}) => ({
		v: 1,
		live: [{ approvalId: "a", revision: 1 }],
		resolved: [{ approvalId: "b", outcome: "resolved_after_response", sentDecision: "accept" }],
		...over,
	});

	test("parses, copying only the named fields", () => {
		const parsed = parseApprovalSync({
			...sync(),
			live: [{ approvalId: "a", revision: 1, extra: 1 }],
		});
		expect(parsed).toEqual({
			v: 1,
			live: [{ approvalId: "a", revision: 1 }],
			resolved: [{ approvalId: "b", outcome: "resolved_after_response", sentDecision: "accept" }],
		});
	});

	test("every tracker outcome and a null sentDecision are accepted", () => {
		for (const outcome of TRACKER_OUTCOMES) {
			expect(
				parseApprovalSync(sync({ resolved: [{ approvalId: "b", outcome, sentDecision: null }] })),
				outcome,
			).not.toBeNull();
		}
	});

	test("the caps: 64 live and 256 resolved pass, one more of either is refused", () => {
		const live = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ approvalId: `a${i}`, revision: 1 }));
		const resolved = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				approvalId: `r${i}`,
				outcome: "declined_local",
				sentDecision: "decline",
			}));
		expect(parseApprovalSync(sync({ live: live(64) }))).not.toBeNull();
		expect(parseApprovalSync(sync({ live: live(65) }))).toBeNull();
		expect(parseApprovalSync(sync({ resolved: resolved(256) }))).not.toBeNull();
		expect(parseApprovalSync(sync({ resolved: resolved(257) }))).toBeNull();
	});

	test("anything malformed is refused", () => {
		const bad: Array<[string, unknown]> = [
			["unknown v", sync({ v: 2 })],
			["live missing", sync({ live: undefined })],
			["live entry without an id", sync({ live: [{ revision: 1 }] })],
			["live revision float", sync({ live: [{ approvalId: "a", revision: 0.5 }] })],
			[
				"unknown outcome",
				sync({ resolved: [{ approvalId: "b", outcome: "applied", sentDecision: null }] }),
			],
			[
				"unknown decision",
				sync({
					resolved: [
						{ approvalId: "b", outcome: "respond_sent", sentDecision: "acceptForSession" },
					],
				}),
			],
			["sentDecision missing", sync({ resolved: [{ approvalId: "b", outcome: "respond_sent" }] })],
			["id too long", sync({ live: [{ approvalId: "a".repeat(129), revision: 1 }] })],
		];
		for (const [label, body] of bad) expect(parseApprovalSync(body), label).toBeNull();
	});
});
