import { create } from "zustand";
import { browserStorage } from "../lib/id-set-storage.js";
import {
	type IndexPair,
	MAX_DRAFTS,
	draftKey,
	draftKeyPrefix,
	draftWritesAllowed,
	indexKey,
	parseEntry,
	parseIndex,
	viewerTag,
} from "../lib/prompt-draft-keys.js";
import { useUserStore } from "./user-store.js";

/** Writes are trailing and per session. */
export const DRAFT_DEBOUNCE_MS = 400;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A longer draft stays in memory and is not stored. Nothing is ever truncated. */
export const DRAFT_MAX_PERSISTED_CHARS = 20_000;
/** A POST with no answer by now settles as "unknown": it may have been queued with the answer lost. */
export const SEND_ANSWER_TIMEOUT_MS = 30_000;
/** The index is rewritten when its order changes, or when the front entry's time has fallen this far behind. */
const INDEX_REFRESH_MS = 10 * 60 * 1000;

export interface Draft {
	text: string;
	savedAt: number;
	/** Loaded from storage and not edited since. */
	restored: boolean;
	/** Written to storage on the next flush. False for text put back after an unknown outcome, until it is edited. */
	persist: boolean;
}

export interface SendTicket {
	readonly sessionId: string;
	readonly version: number;
	readonly generation: number;
}

/** A send in progress: its text, shown read-only in every box for the session, and the action to follow once the POST answered. */
export interface Sending {
	text: string;
	ticket: SendTicket;
	actionId: string | null;
}

export type SendOutcome = "succeeded" | "failed" | "unknown";

interface PromptDraftStore {
	drafts: Record<string, Draft>;
	sending: Record<string, Sending>;
	edit: (sessionId: string, text: string) => void;
	/** Removes the draft at once (memory and storage) and returns it for an undo; null when there is none or a send is in progress. */
	discard: (sessionId: string) => Draft | null;
	/** Puts a discarded draft back unless a send started or something was typed since. */
	undoDiscard: (sessionId: string, draft: Draft) => boolean;
	/** Marks the send; null when one is already in progress. `onTimeout` runs if the POST has no answer in time. */
	beginSend: (sessionId: string, text: string, onTimeout?: () => void) => SendTicket | null;
	/** The POST answered 202. True when the caller should follow the action (the marker is still ours). */
	sendAccepted: (ticket: SendTicket, actionId: string, follow: boolean) => boolean;
	sendRefused: (ticket: SendTicket) => void;
	/** The send is over. For failed and unknown, puts the text back; returns whether it did. */
	sendSettled: (ticket: SendTicket, outcome: SendOutcome, text: string) => boolean;
	flush: (sessionId?: string) => void;
}

// Runtime state, deliberately not in React state.
const versions = new Map<string, number>();
let generation = 0;
let currentTag: string | null = null;
let indexMem: IndexPair[] = [];
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sendTimers = new Map<SendTicket, ReturnType<typeof setTimeout>>();
let pagehideInstalled = false;

const getStorage = (): Storage | null => browserStorage() ?? null;

function bump(sessionId: string): number {
	const next = (versions.get(sessionId) ?? 0) + 1;
	versions.set(sessionId, next);
	return next;
}

function guarded(action: (storage: Storage) => void): void {
	const storage = getStorage();
	if (!storage) return;
	try {
		action(storage);
	} catch {
		// Quota or a refusing store: the draft stays in memory.
	}
}

function writeIndex(storage: Storage, tag: string): void {
	if (draftWritesAllowed()) storage.setItem(indexKey(tag), JSON.stringify(indexMem));
}

function cancelWrite(sessionId: string): void {
	const timer = writeTimers.get(sessionId);
	if (timer !== undefined) clearTimeout(timer);
	writeTimers.delete(sessionId);
}

function removeStored(sessionId: string): void {
	const tag = currentTag;
	if (tag === null) return;
	guarded((storage) => {
		storage.removeItem(draftKey(tag, sessionId));
		if (indexMem.some(([id]) => id === sessionId)) {
			indexMem = indexMem.filter(([id]) => id !== sessionId);
			writeIndex(storage, tag);
		}
	});
}

function writeDraft(sessionId: string): void {
	const tag = currentTag;
	const entry = usePromptDraftStore.getState().drafts[sessionId];
	if (tag === null) return;
	if (!entry || !entry.persist || entry.text.length > DRAFT_MAX_PERSISTED_CHARS) {
		removeStored(sessionId);
		return;
	}
	if (!draftWritesAllowed()) return;
	guarded((storage) => {
		storage.setItem(draftKey(tag, sessionId), JSON.stringify({ t: entry.text, at: entry.savedAt }));
		const front = indexMem[0];
		const unchanged =
			front !== undefined && front[0] === sessionId && entry.savedAt - front[1] < INDEX_REFRESH_MS;
		if (unchanged) return;
		indexMem = [[sessionId, entry.savedAt], ...indexMem.filter(([id]) => id !== sessionId)];
		const evicted = indexMem.splice(MAX_DRAFTS);
		for (const [id] of evicted) {
			storage.removeItem(draftKey(tag, id));
			cancelWrite(id);
		}
		writeIndex(storage, tag);
		if (evicted.length > 0) {
			const gone = new Set(evicted.map(([id]) => id));
			usePromptDraftStore.setState((state) => ({
				drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => !gone.has(id))),
			}));
		}
	});
}

function scheduleWrite(sessionId: string): void {
	cancelWrite(sessionId);
	writeTimers.set(
		sessionId,
		setTimeout(() => {
			writeTimers.delete(sessionId);
			writeDraft(sessionId);
		}, DRAFT_DEBOUNCE_MS),
	);
}

function flushPending(sessionId?: string): void {
	const ids = sessionId === undefined ? [...writeTimers.keys()] : [sessionId];
	for (const id of ids) {
		if (!writeTimers.has(id)) continue;
		cancelWrite(id);
		writeDraft(id);
	}
}

function ensurePagehideFlush(): void {
	if (pagehideInstalled || typeof window === "undefined") return;
	if (typeof window.addEventListener !== "function") return;
	window.addEventListener("pagehide", () => flushPending());
	pagehideInstalled = true;
}

function clearSendTimer(ticket: SendTicket): void {
	const timer = sendTimers.get(ticket);
	if (timer !== undefined) clearTimeout(timer);
	sendTimers.delete(ticket);
}

function withoutSending(sessionId: string): Record<string, Sending> {
	const { [sessionId]: _removed, ...rest } = usePromptDraftStore.getState().sending;
	return rest;
}

/** The draft is the sent text and nothing was typed since (same version, same viewer). */
function clearSent(ticket: SendTicket): void {
	if (ticket.generation !== generation) return;
	if ((versions.get(ticket.sessionId) ?? 0) !== ticket.version) return;
	const { drafts } = usePromptDraftStore.getState();
	if (!(ticket.sessionId in drafts)) return;
	const { [ticket.sessionId]: _removed, ...rest } = drafts;
	cancelWrite(ticket.sessionId);
	usePromptDraftStore.setState({ drafts: rest });
	removeStored(ticket.sessionId);
}

export const usePromptDraftStore = create<PromptDraftStore>((set, get) => ({
	drafts: {},
	sending: {},

	edit: (sessionId, text) => {
		if (get().sending[sessionId]) return;
		bump(sessionId);
		if (text === "") {
			cancelWrite(sessionId);
			const { [sessionId]: _removed, ...rest } = get().drafts;
			set({ drafts: rest });
			removeStored(sessionId);
			return;
		}
		ensurePagehideFlush();
		set((state) => ({
			drafts: {
				...state.drafts,
				[sessionId]: { text, savedAt: Date.now(), restored: false, persist: true },
			},
		}));
		scheduleWrite(sessionId);
	},

	discard: (sessionId) => {
		const draft = get().drafts[sessionId];
		if (!draft || get().sending[sessionId]) return null;
		bump(sessionId);
		cancelWrite(sessionId);
		const { [sessionId]: _removed, ...rest } = get().drafts;
		set({ drafts: rest });
		removeStored(sessionId);
		return draft;
	},

	undoDiscard: (sessionId, draft) => {
		if (get().sending[sessionId]) return false;
		if ((get().drafts[sessionId]?.text ?? "") !== "") return false;
		get().edit(sessionId, draft.text);
		return true;
	},

	beginSend: (sessionId, text, onTimeout) => {
		if (get().sending[sessionId]) return null;
		const ticket: SendTicket = {
			sessionId,
			version: versions.get(sessionId) ?? 0,
			generation,
		};
		set((state) => ({
			sending: { ...state.sending, [sessionId]: { text, ticket, actionId: null } },
		}));
		sendTimers.set(
			ticket,
			setTimeout(() => {
				sendTimers.delete(ticket);
				if (get().sending[sessionId]?.ticket !== ticket) return;
				get().sendSettled(ticket, "unknown", text);
				onTimeout?.();
			}, SEND_ANSWER_TIMEOUT_MS),
		);
		return ticket;
	},

	sendAccepted: (ticket, actionId, follow) => {
		clearSent(ticket);
		const marker = get().sending[ticket.sessionId];
		if (marker?.ticket !== ticket) return false;
		clearSendTimer(ticket);
		if (!follow) {
			set({ sending: withoutSending(ticket.sessionId) });
			return false;
		}
		set((state) => ({
			sending: { ...state.sending, [ticket.sessionId]: { ...marker, actionId } },
		}));
		return true;
	},

	sendRefused: (ticket) => {
		clearSendTimer(ticket);
		if (get().sending[ticket.sessionId]?.ticket !== ticket) return;
		set({ sending: withoutSending(ticket.sessionId) });
	},

	sendSettled: (ticket, outcome, text) => {
		clearSendTimer(ticket);
		if (get().sending[ticket.sessionId]?.ticket === ticket) {
			set({ sending: withoutSending(ticket.sessionId) });
		}
		if (outcome === "succeeded") return false;
		if (ticket.generation !== generation) return false;
		const existing = get().drafts[ticket.sessionId];
		if (existing && existing.text !== "") {
			// No 202 ever cleared it (the send timed out): the text is still in the box if nothing changed it.
			if ((versions.get(ticket.sessionId) ?? 0) !== ticket.version) return false;
			if (outcome === "unknown" && existing.persist) {
				// It may have been sent, so a stored copy must not read as "not sent".
				cancelWrite(ticket.sessionId);
				set((state) => ({
					drafts: { ...state.drafts, [ticket.sessionId]: { ...existing, persist: false } },
				}));
				removeStored(ticket.sessionId);
			}
			return true;
		}
		const persist = outcome === "failed";
		set((state) => ({
			drafts: {
				...state.drafts,
				[ticket.sessionId]: { text, savedAt: Date.now(), restored: false, persist },
			},
		}));
		if (persist) {
			ensurePagehideFlush();
			scheduleWrite(ticket.sessionId);
		}
		return true;
	},

	flush: (sessionId) => flushPending(sessionId),
}));

function cancelAllTimers(): void {
	for (const timer of writeTimers.values()) clearTimeout(timer);
	writeTimers.clear();
	for (const timer of sendTimers.values()) clearTimeout(timer);
	sendTimers.clear();
}

/** Reads this viewer's drafts: TTL and the 30-draft limit from the index alone, then at most 30 bodies. Never throws. */
function loadStored(tag: string): Record<string, Draft> {
	const drafts: Record<string, Draft> = {};
	indexMem = [];
	guarded((storage) => {
		const raw = storage.getItem(indexKey(tag));
		const now = Date.now();
		const survivors: IndexPair[] = [];
		for (const [id, at] of parseIndex(raw)) {
			if (now - at > DRAFT_TTL_MS) continue;
			const entry = parseEntry(storage.getItem(draftKey(tag, id)));
			if (!entry || entry.t === "") continue;
			drafts[id] = { text: entry.t, savedAt: at, restored: true, persist: true };
			survivors.push([id, at]);
		}
		indexMem = survivors;
		const keep = new Set(survivors.map(([id]) => draftKey(tag, id)));
		const stale: string[] = [];
		const prefix = draftKeyPrefix(tag);
		for (let i = 0; i < (storage.length ?? 0); i++) {
			const key = storage.key(i);
			if (key?.startsWith(prefix) && !keep.has(key)) stale.push(key);
		}
		for (const key of stale) storage.removeItem(key);
		if ((raw ?? "") !== JSON.stringify(survivors) && !(raw === null && survivors.length === 0)) {
			writeIndex(storage, tag);
		}
	});
	return drafts;
}

/** Nobody is known: drop the previous viewer's drafts and markers from memory. Their stored drafts stay for their next visit. */
function forget(): void {
	cancelAllTimers();
	generation++;
	versions.clear();
	currentTag = null;
	indexMem = [];
	usePromptDraftStore.setState({ drafts: {}, sending: {} });
}

function adopt(tag: string | null): void {
	flushPending();
	cancelAllTimers();
	generation++;
	versions.clear();
	currentTag = tag;
	const drafts = tag === null ? {} : loadStored(tag);
	usePromptDraftStore.setState({ drafts, sending: {} });
}

// Drafts follow the signed-in person (the pattern of tabs-store). A viewer who can't be told apart from
// another (no id while auth is on) gets memory only.
let adoptedFor: { tag: string | null } | null = null;
function adoptViewer(): void {
	const { loaded, userId, disableAuth } = useUserStore.getState();
	if (!loaded) {
		if (adoptedFor) forget();
		adoptedFor = null;
		return;
	}
	const tag = userId !== null ? viewerTag(userId) : disableAuth ? viewerTag(null) : null;
	if (adoptedFor && adoptedFor.tag === tag) return;
	adoptedFor = { tag };
	adopt(tag);
}
useUserStore.subscribe(adoptViewer);
adoptViewer();

export function __resetPromptDraftsForTests(): void {
	cancelAllTimers();
	generation++;
	versions.clear();
	currentTag = null;
	indexMem = [];
	usePromptDraftStore.setState({ drafts: {}, sending: {} });
	adoptedFor = null;
	adoptViewer();
}
