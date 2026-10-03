/**
 * Randomised session rows for tests that compare one way of classifying
 * sessions against another: every lifecycle status, the three stored timestamp
 * formats plus an unparsable one, permission waits of every shape (and
 * decoys), acknowledgements before and after the finished turn.
 */
import { getDb } from "../db/client.js";
import { sessions } from "../db/schema/index.js";

/** Deterministic pseudo-random numbers so a failure reproduces. */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const BASE = Date.parse("2026-09-30T12:00:00.000Z");

/** The three stored timestamp formats, plus an unparsable value. */
function stamp(rand: () => number, offsetMs: number): string {
	const date = new Date(BASE + offsetMs);
	const iso = date.toISOString();
	const roll = rand();
	if (roll < 0.6) return iso;
	if (roll < 0.8) return iso.slice(0, 19).replace("T", " ");
	if (roll < 0.95) return `${iso.slice(0, 19).replace("T", " ")}+00`;
	return "not a timestamp";
}

function pick<T>(rand: () => number, values: readonly T[]): T {
	return values[Math.floor(rand() * values.length)] as T;
}

function randomMetadata(rand: () => number): Record<string, unknown> {
	const roll = rand();
	if (roll < 0.35) return {};
	if (roll < 0.5) return { note: "x".repeat(Math.floor(rand() * 60)) };
	if (roll < 0.62) return { permissionWait: { ids: ["t1"], anon: 0 } };
	if (roll < 0.68) return { permissionWait: { ids: [], anon: 2 } };
	if (roll < 0.74) return { permissionWait: { ids: [], anon: 0 } };
	if (roll < 0.78) return { permissionWait: null, other: 1 };
	if (roll < 0.82) return { permissionWait: "waiting" };
	if (roll < 0.85) return { permissionWait: 3 };
	if (roll < 0.88) return { permissionWait: ["t1"] };
	if (roll < 0.91) return { permissionWait: { ids: "t1", anon: "2" } };
	if (roll < 0.92) return { permissionWait: '{"ids":["t1"],"anon":0}' };
	if (roll < 0.94) return { permissionWait: { anon: 1 }, renameSource: "user", nativeName: "n" };
	return { permissionWait: { ids: ["a", "b"], anon: 0 }, nested: { permissionWait: "decoy" } };
}

export function randomRow(rand: () => number, i: number) {
	const status = pick(rand, [
		"active",
		"active",
		"active",
		"idle",
		"failed",
		"completed",
		"archived",
	]);
	const turn = rand() < 0.5 ? null : stamp(rand, -Math.floor(rand() * 3_600_000));
	const ack = rand() < 0.5 ? null : stamp(rand, -Math.floor(rand() * 3_600_000));
	const ended =
		status === "failed" || status === "completed" || rand() < 0.1
			? stamp(rand, -Math.floor(rand() * 3_600_000))
			: null;
	return {
		sessionId: `prop-${i}`,
		displayName: `prop-${i}`,
		agentType: "claude_code",
		status,
		isWorking: rand() < 0.3,
		isArchived: rand() < 0.05,
		endedAt: ended,
		semanticStatus: pick(rand, [null, null, "waiting", "working", "done"]),
		metadata: randomMetadata(rand),
		lastAgentTurnCompletedAt: turn,
		lastUserAcknowledgedAt: ack,
		lastActivityAt: new Date(BASE - Math.floor(rand() * 86_400_000)).toISOString(),
	};
}

export async function insertAll(rows: Array<Record<string, unknown>>) {
	for (let i = 0; i < rows.length; i += 200) {
		await getDb()
			.insert(sessions)
			.values(rows.slice(i, i + 200) as never)
			.execute();
	}
}
