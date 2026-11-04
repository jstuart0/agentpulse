/**
 * Codex approvals, phase 4: what the person routes put on the wire (D17).
 * Responses are compared with committed fixtures by exact, recursive key sets
 * (volatile values masked), scanned for every persistence-only field, and the
 * serializers are shown to drop a field they were not told about.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import type {
	CodexApprovalDecisionResponse,
	CodexApprovalDetail,
	CodexApprovalList,
} from "../../shared/codex-approvals.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import { clearInstanceSettings } from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { codexApprovals } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { recordApprovalRequest, closeApprovalsForSession } = await import(
	"../services/codex-approvals.js"
);
const { canonicalJson } = await import("../services/codex-approval-presentation.js");
const { sha256Hex } = await import("../services/util/hash.js");
const { config } = await import("../config.js");
const { serializeApprovalDecision, serializeApprovalDetail, serializeApprovalList } = await import(
	"./codex-approvals.js"
);

const FIXTURES = join(import.meta.dir, "__fixtures__/codex-approvals");
const originalDisableAuth = config.disableAuth;

beforeAll(() => initializeDatabase());

const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

// Solo with auth off: the operator, as a person. The wire shape does not depend on who asks.
let counter = 0;
const IDS = {
	rpc: "wire-rpc-id-7731",
	thread: "wire-thread-id-7731",
	turn: "wire-turn-id-7731",
	item: "wire-item-id-7731",
	epoch: "wire-epoch-7731",
	provider: "wire-provider-approval-7731",
};
async function seed() {
	counter++;
	const sessionId = `wire-session-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	const supervisorId = `wire-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	sessionsUsed.push(sessionId);
	hostsUsed.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId });
	return { sessionId, supervisorId };
}

async function openCommand(ctx: { sessionId: string; supervisorId: string }) {
	const { response } = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport({
			runtimeEpoch: IDS.epoch,
			rpcId: `${IDS.rpc}-${crypto.randomUUID()}`,
			threadId: IDS.thread,
			turnId: IDS.turn,
			itemId: `${IDS.item}-${crypto.randomUUID()}`,
			providerApprovalId: IDS.provider,
			command: "npm test -- --runInBand",
			reason: "run the unit tests",
		}),
	);
	return response.approvalId;
}

async function openFileChange(ctx: { sessionId: string; supervisorId: string }) {
	const { response } = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.fileChangeReport({
			runtimeEpoch: IDS.epoch,
			rpcId: `${IDS.rpc}-${crypto.randomUUID()}`,
			threadId: IDS.thread,
			turnId: IDS.turn,
			itemId: `${IDS.item}-${crypto.randomUUID()}`,
			reason: "add a greeting",
		}),
	);
	return response.approvalId;
}

const MASKED = new Set(["id", "createdAt", "expiresAt", "answeredAt", "presentationHash"]);
function mask(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) return value.map((v) => mask(v));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mask(v, k)]),
		);
	}
	if (key === "expiresInSeconds") return typeof value === "number" ? "<seconds>" : value;
	if (key && MASKED.has(key) && typeof value === "string") return `<${key}>`;
	return value;
}

function expectFixture(name: string, actual: unknown) {
	const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
	expect(mask(actual)).toEqual(expected);
}

async function getJson<T>(path: string): Promise<T> {
	(config as Record<string, unknown>).disableAuth = true;
	const res = await app.request(path);
	expect(res.status).toBe(200);
	return (await res.json()) as T;
}

const base = (sessionId: string) => `/api/v1/sessions/${sessionId}/approvals`;

// Every persistence-only name from D17's "never on a response", in both spellings.
const FORBIDDEN_KEYS = [
	"runtimeEpoch",
	"runtime_epoch",
	"rpcId",
	"rpc_id",
	"threadId",
	"thread_id",
	"turnId",
	"turn_id",
	"itemId",
	"item_id",
	"providerApprovalId",
	"provider_approval_id",
	"firstDeliveredAt",
	"first_delivered_at",
	"fencedAt",
	"fenced_at",
	"keyId",
	"key_id",
	"userId",
	"user_id",
	"answeredByUserId",
	"answeredByKeyId",
	"sessionId",
	"supervisorId",
	"closedReason",
	"closedAt",
	"updatedAt",
];

function keysOf(value: unknown, found: Set<string> = new Set()): Set<string> {
	if (Array.isArray(value)) for (const v of value) keysOf(v, found);
	else if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			found.add(k);
			keysOf(v, found);
		}
	}
	return found;
}

describe("the three responses against their fixtures", () => {
	test("list: an open command and an open file change", async () => {
		const ctx = await seed();
		await openCommand(ctx);
		await openFileChange(ctx);
		const list = await getJson<CodexApprovalList>(base(ctx.sessionId));
		expect(list.approvals).toHaveLength(2);
		expectFixture("list-open", list);
	});

	test("list: a closed row has no preview", async () => {
		const ctx = await seed();
		await openCommand(ctx);
		await closeApprovalsForSession(ctx.sessionId);
		const list = await getJson<CodexApprovalList>(base(ctx.sessionId));
		expect(list.approvals[0]?.preview).toBeNull();
		expectFixture("list-closed", list);
	});

	test("detail: a command, a file change and a closed row", async () => {
		const ctx = await seed();
		const command = await openCommand(ctx);
		const change = await openFileChange(ctx);
		expectFixture(
			"detail-command",
			await getJson<CodexApprovalDetail>(`${base(ctx.sessionId)}/${command}`),
		);
		expectFixture(
			"detail-file-change",
			await getJson<CodexApprovalDetail>(`${base(ctx.sessionId)}/${change}`),
		);
		await closeApprovalsForSession(ctx.sessionId);
		const closed = await getJson<CodexApprovalDetail>(`${base(ctx.sessionId)}/${command}`);
		expect(closed.presentation).toBeNull();
		expect(closed.reasonText).toBeNull();
		expect(closed.approval.preview).toBeNull();
		expectFixture("detail-closed", closed);
	});

	test("decision: an accept and a decline", async () => {
		const ctx = await seed();
		const a = await openCommand(ctx);
		const b = await openCommand(ctx);
		const [rowA] = await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, a));
		(config as Record<string, unknown>).disableAuth = true;
		const post = (id: string, body: unknown) =>
			app.request(`${base(ctx.sessionId)}/${id}/decision`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Host: "localhost:3000" },
				body: JSON.stringify(body),
			});
		const accepted = await post(a, {
			decision: "accept",
			presentationHash: rowA?.presentationHash,
		});
		const declined = await post(b, { decision: "decline" });
		expect([accepted.status, declined.status]).toEqual([200, 200]);
		expectFixture("decision-accept", await accepted.json());
		expectFixture("decision-decline", await declined.json());
	});
});

describe("nothing persistence-only leaves", () => {
	test("rpcId and the other 26 names are in no key of any response, and no seeded value is in any body", async () => {
		const ctx = await seed();
		const a = await openCommand(ctx);
		const b = await openFileChange(ctx);
		const bodies: unknown[] = [
			await getJson(base(ctx.sessionId)),
			await getJson(`${base(ctx.sessionId)}/${a}`),
			await getJson(`${base(ctx.sessionId)}/${b}`),
		];
		(config as Record<string, unknown>).disableAuth = true;
		const [rowA] = await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, a));
		const decided = await app.request(`${base(ctx.sessionId)}/${a}/decision`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: "localhost:3000" },
			body: JSON.stringify({ decision: "accept", presentationHash: rowA?.presentationHash }),
		});
		bodies.push(await decided.json());

		expect(FORBIDDEN_KEYS.length).toBeGreaterThanOrEqual(7);
		expect(FORBIDDEN_KEYS).toContain("rpcId");
		for (const body of bodies) {
			const keys = keysOf(body);
			expect(keys.size).toBeGreaterThan(10);
			for (const name of FORBIDDEN_KEYS)
				expect({ name, present: keys.has(name) }).toEqual({ name, present: false });
			const text = JSON.stringify(body);
			for (const value of Object.values(IDS)) expect(text).not.toContain(value);
			expect(text).not.toContain(ctx.sessionId);
			expect(text).not.toContain(ctx.supervisorId);
		}
	});

	test("the serializers drop a field they were not told about, at every depth", () => {
		const extra = { rpcId: "x", runtimeEpoch: "x", threadId: "x" };
		const summary = {
			id: "a",
			requestKind: "command",
			state: "pending",
			outcome: null,
			decision: null,
			answeredAt: null,
			revision: 1,
			presentationHash: "h",
			approvable: true,
			notApprovableReason: null,
			canCancel: false,
			createdAt: "t",
			expiresAt: "t",
			expiresInSeconds: 5,
			preview: {
				cwd: "/w",
				paths: [{ path: "/w/a", kind: "add", ...extra }],
				pathOutsideCwd: false,
				nonAscii: false,
				...extra,
			},
			...extra,
		};
		const list = serializeApprovalList({
			v: 1,
			approvals: [summary],
			host: { state: "live", name: "h", ...extra },
			viewer: { canAccept: true, ...extra },
			...extra,
		} as unknown as CodexApprovalList);
		const detail = serializeApprovalDetail({
			v: 1,
			approval: summary,
			presentation: {
				v: 1,
				requestKind: "file_change",
				changes: [{ path: "/w/a", kind: "add", movePath: null, diff: "+x", ...extra }],
				cwd: "/w",
				reason: null,
				grantRoot: null,
				...extra,
			},
			reasonText: null,
			...extra,
		} as unknown as CodexApprovalDetail);
		const decision = serializeApprovalDecision({
			v: 1,
			approval: summary,
			...extra,
		} as unknown as CodexApprovalDecisionResponse);
		for (const out of [list, detail, decision]) {
			const keys = keysOf(out);
			for (const name of Object.keys(extra)) expect(keys.has(name)).toBe(false);
		}
		expect(keysOf(detail).has("diff")).toBe(true);
	});
});

describe("the presentation and its hash", () => {
	test("for an open row, sha256 of the canonical presentation equals presentationHash (command and file change)", async () => {
		const ctx = await seed();
		const a = await openCommand(ctx);
		const b = await openFileChange(ctx);
		for (const id of [a, b]) {
			const detail = await getJson<CodexApprovalDetail>(`${base(ctx.sessionId)}/${id}`);
			expect(detail.presentation).not.toBeNull();
			expect(sha256Hex(canonicalJson(detail.presentation))).toBe(detail.approval.presentationHash);
		}
	});

	test("a closed row has a null presentation and a null preview", async () => {
		const ctx = await seed();
		const a = await openCommand(ctx);
		await closeApprovalsForSession(ctx.sessionId);
		const detail = await getJson<CodexApprovalDetail>(`${base(ctx.sessionId)}/${a}`);
		const list = await getJson<CodexApprovalList>(base(ctx.sessionId));
		expect(detail.presentation).toBeNull();
		expect(detail.approval.preview).toBeNull();
		expect(list.approvals.every((x) => x.preview === null)).toBe(true);
	});
});
