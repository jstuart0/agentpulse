import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummaryView } from "../../shared/session-summary-view.js";
import { type PolledSessionSummaryView, api } from "../lib/api.js";
import {
	type RefusalCopy,
	type SummaryViewer,
	needsShrinkConfirmation,
	refusalCopy,
	selectSummaryFlag,
} from "../lib/session-summary-core.js";
import type { SummaryLoad } from "../lib/session-summary-view.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useSummaryViewer } from "./useSummaryViewer.js";

/** Milliseconds between polls while a generation runs. */
export const SUMMARY_POLL_INTERVAL_MS = 2000;
/**
 * Whether a poll asks the server to leave the stored summary out (`?poll=1`). Off until the server
 * route that answers it ships: the hook already copes with a view that says `storedOmitted`.
 */
export const SUMMARY_SEND_POLL_PARAM = false;
/** Consecutive poll failures tolerated before contact is reported lost. */
export const SUMMARY_POLL_RETRIES = 3;
/** The countdown for a cooldown or a rate limit re-reads its deadline once a second. */
export const COOLDOWN_TICK_MS = 1000;

export type SummaryAnnouncement = "Summarizing" | "Summary ready" | "Summary failed";

export interface UseSessionSummary {
	load: SummaryLoad;
	/**
	 * Polling gave up after repeated failures. `load` still holds the last view, so a readable
	 * summary is never replaced by "Couldn't load the summary"; show "Lost contact with the
	 * server" with `retry` beside it. False whenever there is no view yet (that is `load: error`).
	 */
	lostContact: boolean;
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
	 * One click. `needs_confirmation` when the model supplies confirm text (the evidence has
	 * shrunk and a summary exists) and the caller hasn't confirmed (nothing is sent); `ignored`
	 * while a request or generation is already running.
	 */
	generate: (options?: {
		confirmed?: boolean;
	}) => Promise<"started" | "needs_confirmation" | "refused" | "ignored">;
	/** For the Retry beside "Couldn't load the summary" and "Lost contact with the server". */
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
	lostContact: boolean;
	startedHere: boolean;
	announcement: SummaryAnnouncement | null;
	newResult: boolean;
	refusal: RefusalState | null;
}

const INITIAL: State = {
	forSession: null,
	load: { status: "loading" },
	lostContact: false,
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

type ReadKind = "initial" | "poll" | "refetch" | "retry";

const isGenerating = (view: SessionSummaryView | null) => view?.attempt.status === "generating";

/** A view that says it left the stored summary out keeps the one already on screen. */
function withKeptSummary(
	next: PolledSessionSummaryView,
	previous: SessionSummaryView | null,
): SessionSummaryView {
	const { storedOmitted, ...view } = next;
	return storedOmitted && view.stored === null && previous
		? { ...view, stored: previous.stored }
		: view;
}

/** What the refusal was about when it was shown: a change in either makes it stale. */
interface RefusalAnchor {
	context: string;
	view: string;
}

const secondsLeft = (deadline: number) => Math.ceil((deadline - Date.now()) / 1000);

/**
 * One session's summary: the first read, polling while (and only while) a generation runs, the
 * click, and the countdowns. Everything stateful lives in this closure so one disposal ends every
 * timer and subscription and turns every late answer into a no-op, which is what makes a session
 * change safe.
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
	let refusalAnchor: RefusalAnchor | null = null;
	let refusalDeadline: number | null = null;
	let cooldownDeadline: number | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let tickTimer: ReturnType<typeof setTimeout> | null = null;

	const commit = (patch: Partial<State>) =>
		setState((prev) => (prev.forSession === sessionId ? { ...prev, ...patch } : prev));
	const commitView = (next: SessionSummaryView) => {
		view = next;
		commit({ load: { status: "ready", view: next } });
	};

	/** Everything outside the view that decides what the action says: AI state and the Labs flag. */
	function contextKey(): string {
		const ai = useAiStatusStore.getState().status;
		const flag = selectSummaryFlag(useLabsStore.getState());
		return `${ai ? [ai.build, ai.runtime, ai.killSwitch].join(",") : "unknown"}|${flag ?? "unknown"}`;
	}
	/** What in the view decides what the action says. */
	function viewKey(): string {
		return view ? `${view.blocked}|${view.attempt.status}|${view.stored !== null}` : "none";
	}

	function clearRefusal() {
		if (refusal === null) return;
		refusal = null;
		refusalAnchor = null;
		refusalDeadline = null;
		commit({ refusal: null });
	}
	function showRefusal(next: RefusalState) {
		refusal = next;
		refusalAnchor = { context: contextKey(), view: viewKey() };
		refusalDeadline = next.seconds !== null ? Date.now() + next.seconds * 1000 : null;
		commit({ refusal: next });
	}
	/** An inline refusal explains a click; once the action says something else, it would only contradict it. */
	function dropStaleRefusal() {
		if (refusalAnchor === null) return;
		if (contextKey() !== refusalAnchor.context || viewKey() !== refusalAnchor.view) clearRefusal();
	}
	const unsubscribes = [
		useAiStatusStore.subscribe(dropStaleRefusal),
		useLabsStore.subscribe(dropStaleRefusal),
	];

	function schedulePoll() {
		if (disposed || !isGenerating(view)) return;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(() => {
			pollTimer = null;
			void read("poll");
		}, SUMMARY_POLL_INTERVAL_MS);
	}

	function cooling() {
		return view?.blocked === "summary_cooldown" && cooldownDeadline !== null;
	}

	function scheduleTick() {
		if (disposed || tickTimer || !(cooling() || refusalDeadline !== null)) return;
		tickTimer = setTimeout(() => {
			tickTimer = null;
			tick();
		}, COOLDOWN_TICK_MS);
	}

	/** A background tab throttles timers, so each tick reads the clock against the deadline instead of counting itself. */
	function tick() {
		if (disposed) return;
		if (view && cooling() && cooldownDeadline !== null) {
			const left = secondsLeft(cooldownDeadline);
			if (left > 0) {
				if (left !== view.cooldownSeconds) commitView({ ...view, cooldownSeconds: left });
			} else {
				cooldownDeadline = null;
				commitView({ ...view, blocked: null, cooldownSeconds: null });
				void read("refetch");
			}
		}
		if (refusal !== null && refusalDeadline !== null) {
			const left = secondsLeft(refusalDeadline);
			if (left > 0) {
				if (left !== refusal.seconds) {
					refusal = { ...refusal, seconds: left };
					commit({ refusal });
				}
			} else clearRefusal();
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
		clearRefusal();
		commit(patch);
	}

	function accept(next: SessionSummaryView) {
		const was = isGenerating(view);
		failures = 0;
		cooldownDeadline =
			next.blocked === "summary_cooldown" && next.cooldownSeconds !== null
				? Date.now() + next.cooldownSeconds * 1000
				: null;
		commitView(next);
		commit({ lostContact: false });
		dropStaleRefusal();
		if (was && !isGenerating(next)) finished(next);
		schedulePoll();
		scheduleTick();
	}

	function failedRead(kind: ReadKind) {
		if (kind === "poll") {
			failures++;
			if (failures <= SUMMARY_POLL_RETRIES) {
				schedulePoll();
				return;
			}
		} else if (kind === "refetch" && view !== null) {
			// The view on screen stays; a generation it still shows as running needs its poll back.
			schedulePoll();
			return;
		}
		if (view !== null) commit({ lostContact: true });
		else commit({ load: { status: "error" } });
	}

	async function read(kind: ReadKind) {
		if (disposed) return;
		if (busy) {
			readAgain = true;
			return;
		}
		busy = true;
		let next: PolledSessionSummaryView | null = null;
		try {
			next = await api.getSessionSummary(sessionId, {
				poll: kind === "poll" && SUMMARY_SEND_POLL_PARAM,
			});
		} catch {
			next = null;
		}
		busy = false;
		if (disposed) return;
		if (next?.storedOmitted && next.attempt.status === "idle" && isGenerating(view)) {
			// A poll saw the generation end but left the new summary out: read it in full. A full
			// read that still leaves it out is a failed read: back off on the poll interval, bounded.
			if (kind === "poll") readAgain = true;
			else failedRead("poll");
		} else if (next) accept(withKeptSummary(next, view));
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
		if (needsShrinkConfirmation(before) && !options?.confirmed) return "needs_confirmation";
		posting = true;
		clearRefusal();
		commitView({
			...before,
			attempt: { status: "generating", startedAt: new Date().toISOString(), errorCode: null },
			blocked: null,
			cooldownSeconds: null,
		});
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
			showRefusal({
				status: refused.status,
				code: refused.code,
				seconds: copy.countdownSeconds,
			});
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
			if (view !== null) {
				void read("retry");
				return;
			}
			commit({ load: { status: "loading" } });
			void read("initial");
		},
		dispose() {
			disposed = true;
			if (pollTimer) clearTimeout(pollTimer);
			if (tickTimer) clearTimeout(tickTimer);
			pollTimer = null;
			tickTimer = null;
			for (const unsubscribe of unsubscribes) unsubscribe();
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
	const viewer = useSummaryViewer();
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
	const { adminSettingsLocked } = viewer;
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
		lostContact: current.lostContact,
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
