import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummaryView } from "../../shared/session-summary-view.js";
import { api } from "../lib/api.js";
import {
	type RefusalCopy,
	type SummaryLoad,
	type SummaryViewer,
	refusalCopy,
} from "../lib/session-summary-view.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useOwnershipUi } from "./useOwnershipUi.js";

/** Milliseconds between polls while a generation runs. */
export const SUMMARY_POLL_INTERVAL_MS = 2000;
/** Consecutive poll failures tolerated before the load is reported as failed. */
export const SUMMARY_POLL_RETRIES = 3;
/** The countdown for a cooldown or a rate limit ticks once a second. */
export const COOLDOWN_TICK_MS = 1000;

export type SummaryAnnouncement = "Summarizing" | "Summary ready" | "Summary failed";

export interface UseSessionSummary {
	load: SummaryLoad;
	/** A generation is running (started here, elsewhere, or reported by the server on arrival). */
	generating: boolean;
	/** The viewer started the running generation (a joined one doesn't count). */
	startedHere: boolean;
	/** For the page's live region; only ever set for a generation this viewer started. */
	announcement: SummaryAnnouncement | null;
	/** A generation was seen finishing, with a summary, during this visit. Cleared by `clearNew`. */
	newResult: boolean;
	/** Inline refusal text beside the button, with its countdown applied. */
	refusal: RefusalCopy | null;
	/**
	 * One click. `needs_confirmation` when the evidence has shrunk and the caller hasn't confirmed
	 * (nothing is sent); `ignored` while a request or generation is already running.
	 */
	generate: (options?: {
		confirmed?: boolean;
	}) => Promise<"started" | "needs_confirmation" | "refused" | "ignored">;
	/** For the "Couldn't load the summary" Retry button. */
	retry: () => void;
	clearNew: () => void;
}

interface RefusalState {
	status: number;
	code: Parameters<typeof refusalCopy>[0]["code"];
	seconds: number | null;
}

interface State {
	forSession: string | null;
	load: SummaryLoad;
	startedHere: boolean;
	announcement: SummaryAnnouncement | null;
	newResult: boolean;
	refusal: RefusalState | null;
}

const INITIAL: State = {
	forSession: null,
	load: { status: "loading" },
	startedHere: false,
	announcement: null,
	newResult: false,
	refusal: null,
};

type Generate = UseSessionSummary["generate"];

interface Controller {
	start: () => void;
	generate: Generate;
	retry: () => void;
	dispose: () => void;
}

const isGenerating = (view: SessionSummaryView | null) => view?.attempt.status === "generating";

/**
 * One session's summary: the first read, polling while (and only while) a generation runs, the
 * click, and the countdowns. Everything stateful lives in this closure so one disposal ends every
 * timer and turns every late answer into a no-op, which is what makes a session change safe.
 */
function createController(
	sessionId: string,
	setState: (update: (prev: State) => State) => void,
	getViewer: () => SummaryViewer,
): Controller {
	let disposed = false;
	let view: SessionSummaryView | null = null;
	let busy = false;
	let readAgain = false;
	let posting = false;
	let ownGeneration = false;
	let failures = 0;
	let refusal: RefusalState | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let tickTimer: ReturnType<typeof setTimeout> | null = null;

	const commit = (patch: Partial<State>) =>
		setState((prev) => (prev.forSession === sessionId ? { ...prev, ...patch } : prev));
	const commitView = (next: SessionSummaryView) => {
		view = next;
		commit({ load: { status: "ready", view: next } });
	};

	function schedulePoll() {
		if (disposed || !isGenerating(view)) return;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(() => {
			pollTimer = null;
			void read("poll");
		}, SUMMARY_POLL_INTERVAL_MS);
	}

	function needsTick() {
		return (
			(view?.blocked === "summary_cooldown" && view.cooldownSeconds !== null) ||
			(refusal !== null && refusal.seconds !== null)
		);
	}

	function scheduleTick() {
		if (disposed || tickTimer || !needsTick()) return;
		tickTimer = setTimeout(() => {
			tickTimer = null;
			tick();
		}, COOLDOWN_TICK_MS);
	}

	function tick() {
		if (disposed) return;
		if (view?.blocked === "summary_cooldown" && view.cooldownSeconds !== null) {
			const left = view.cooldownSeconds - 1;
			if (left > 0) commitView({ ...view, cooldownSeconds: left });
			else {
				commitView({ ...view, blocked: null, cooldownSeconds: null });
				void read("refetch");
			}
		}
		if (refusal !== null && refusal.seconds !== null) {
			const left = refusal.seconds - 1;
			refusal = left > 0 ? { ...refusal, seconds: left } : null;
			commit({ refusal });
		}
		scheduleTick();
	}

	function finished(next: SessionSummaryView) {
		const own = ownGeneration;
		ownGeneration = false;
		const failed = next.attempt.status === "failed";
		const patch: Partial<State> = { startedHere: false };
		if (!failed && next.stored !== null) patch.newResult = true;
		if (own) patch.announcement = failed ? "Summary failed" : "Summary ready";
		commit(patch);
	}

	function accept(next: SessionSummaryView) {
		const was = isGenerating(view);
		failures = 0;
		commitView(next);
		if (was && !isGenerating(next)) finished(next);
		schedulePoll();
		scheduleTick();
	}

	function failedRead(kind: "initial" | "poll" | "refetch") {
		if (kind === "poll") {
			failures++;
			if (failures <= SUMMARY_POLL_RETRIES) {
				schedulePoll();
				return;
			}
		} else if (view !== null) {
			return;
		}
		view = null;
		commit({ load: { status: "error" } });
	}

	async function read(kind: "initial" | "poll" | "refetch") {
		if (disposed) return;
		if (busy) {
			readAgain = true;
			return;
		}
		busy = true;
		let next: SessionSummaryView | null = null;
		try {
			next = await api.getSessionSummary(sessionId);
		} catch {
			next = null;
		}
		busy = false;
		if (disposed) return;
		if (next) accept(next);
		else failedRead(kind);
		if (readAgain) {
			readAgain = false;
			void read("refetch");
		}
	}

	function reread(source: NonNullable<ReturnType<typeof refusalCopy>["refetch"]>) {
		if (source === "view") void read("refetch");
		else if (source === "availability") void useLabsStore.getState().load();
		else
			void useAiStatusStore
				.getState()
				.refresh()
				.catch(() => {});
	}

	const generate: Generate = async (options) => {
		const before = view;
		if (disposed || posting || before === null || isGenerating(before)) return "ignored";
		if (before.evidenceShrunk && !options?.confirmed) return "needs_confirmation";
		posting = true;
		refusal = null;
		commitView({
			...before,
			attempt: { status: "generating", startedAt: new Date().toISOString(), errorCode: null },
			blocked: null,
			cooldownSeconds: null,
		});
		commit({ refusal: null });
		const result = await api.generateSessionSummary(sessionId).catch(() => null);
		posting = false;
		if (disposed) return "ignored";
		if (result?.ok) {
			ownGeneration = !result.body.attempt.joined;
			commitView({
				...before,
				attempt: {
					status: "generating",
					startedAt: result.body.attempt.startedAt,
					errorCode: null,
				},
				blocked: null,
				cooldownSeconds: null,
			});
			commit({
				startedHere: ownGeneration,
				newResult: false,
				...(ownGeneration ? { announcement: "Summarizing" as const } : {}),
			});
			schedulePoll();
			return "started";
		}
		commitView(before);
		const refused = result?.refusal ?? { status: 0, code: null, retryAfterSeconds: null };
		const copy = refusalCopy(refused, getViewer());
		if (copy.text) {
			refusal = { status: refused.status, code: refused.code, seconds: copy.countdownSeconds };
			commit({ refusal });
			scheduleTick();
		}
		if (copy.refetch) reread(copy.refetch);
		return "refused";
	};

	return {
		start: () => void read("initial"),
		generate,
		retry() {
			if (disposed) return;
			failures = 0;
			view = null;
			commit({ load: { status: "loading" } });
			void read("initial");
		},
		dispose() {
			disposed = true;
			if (pollTimer) clearTimeout(pollTimer);
			if (tickTimer) clearTimeout(tickTimer);
			pollTimer = null;
			tickTimer = null;
		},
	};
}

/**
 * The Summary panel's data, meant to be mounted once at page level while the feature is
 * available (`enabled`): one read per page view, polling only while a generation runs.
 */
export function useSessionSummary(
	sessionId: string | undefined,
	enabled: boolean,
): UseSessionSummary {
	const [state, setState] = useState<State>(INITIAL);
	const { adminSettingsLocked, showSummarySharedNote } = useOwnershipUi();
	const aiPanelAvailable = useLabsStore((s) => s.isEnabled("aiSettingsPanel"));
	const viewer: SummaryViewer = { adminSettingsLocked, showSummarySharedNote, aiPanelAvailable };
	const viewerRef = useRef<SummaryViewer>(viewer);
	viewerRef.current = viewer;
	const controller = useRef<Controller | null>(null);

	useEffect(() => {
		if (!enabled || !sessionId) return;
		setState({ ...INITIAL, forSession: sessionId });
		const created = createController(sessionId, setState, () => viewerRef.current);
		controller.current = created;
		created.start();
		return () => {
			created.dispose();
			if (controller.current === created) controller.current = null;
		};
	}, [sessionId, enabled]);

	const active = enabled && !!sessionId && state.forSession === sessionId;
	const current = active ? state : INITIAL;
	const load: SummaryLoad = !enabled || !sessionId ? { status: "unavailable" } : current.load;
	const refusal = useMemo(() => {
		if (!current.refusal) return null;
		const copy = refusalCopy(
			{
				status: current.refusal.status,
				code: current.refusal.code,
				retryAfterSeconds: current.refusal.seconds,
			},
			{ adminSettingsLocked },
		);
		return copy.text ? copy : null;
	}, [current.refusal, adminSettingsLocked]);

	return {
		load,
		generating: load.status === "ready" && isGenerating(load.view),
		startedHere: current.startedHere,
		announcement: current.announcement,
		newResult: current.newResult,
		refusal,
		generate: (options) => controller.current?.generate(options) ?? Promise.resolve("ignored"),
		retry: () => controller.current?.retry(),
		clearNew: () =>
			setState((prev) => (prev.forSession === sessionId ? { ...prev, newResult: false } : prev)),
	};
}
