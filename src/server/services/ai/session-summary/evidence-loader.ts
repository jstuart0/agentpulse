/**
 * AGEN-69: the evidence loader (signature stubs; implementation follows).
 */
import { type SQL, sql } from "drizzle-orm";
import type { EvidenceRow, ScanSummary } from "./ledger.js";

export interface ChunkParams {
	sessionId: string;
	/** The chunk's id window: `lo` is the session's first id, `cursor` the highest id of this chunk. */
	lo: number;
	cursor: number;
	/** Narrative rows still wanted; 0 asks for tool rows only. */
	spineLimit: number;
	/** Tool rows still wanted in this chunk (at most ACTION_ROWS_PER_CHUNK); 0 asks for narrative rows only. */
	actionLimit: number;
	/** The newest chunk may hold the session's last agent message, which is read at a larger cap. */
	newestChunk: boolean;
}

export function buildChunkStatement(_params: ChunkParams): SQL {
	return sql``;
}

export function buildBoundsStatement(_sessionId: string): SQL {
	return sql``;
}

export function buildFirstPromptsStatement(_sessionId: string, _lo: number, _hi: number): SQL {
	return sql``;
}

export interface StatementDiagnostic {
	kind: "bounds" | "chunk" | "first_prompts";
	rows: number;
	/** Characters of text the statement returned into JS. */
	chars: number;
	elapsedMs: number;
}

export interface EvidenceBundle {
	/** `max(id)` read before the evidence; null for a session with no events. */
	throughEventId: number | null;
	/** `min(id)` read before the evidence. */
	firstEventId: number | null;
	rows: EvidenceRow[];
	firstPromptRows: EvidenceRow[];
	scan: ScanSummary;
	diagnostics: { jobs: number; chunks: number; statements: StatementDiagnostic[] };
}

export async function loadEvidence(_sessionId: string): Promise<EvidenceBundle> {
	return {
		throughEventId: null,
		firstEventId: null,
		rows: [],
		firstPromptRows: [],
		scan: {
			eventsTotal: 0,
			eventsRead: 0,
			eligibleRead: 0,
			droppedByCap: 0,
			reachedFirstEvent: true,
			oldestReadAt: null,
		},
		diagnostics: { jobs: 0, chunks: 0, statements: [] },
	};
}
