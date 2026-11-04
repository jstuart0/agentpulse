import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	CodexApprovalDetail,
	CodexApprovalList,
	CodexApprovalSummary,
} from "../../shared/codex-approvals.js";
import type { Session } from "../../shared/types.js";
import {
	detailMatchesRow,
	fetchDelayMs,
	shouldRefetchOnSession,
	splitRows,
	updateKept,
} from "../components/session-detail/codex-approval-view.js";
import { ApiError } from "../lib/api.js";
import { codexApprovalWaitIds } from "../lib/codex-approval-wait.js";
import { getCodexApproval, listCodexApprovals } from "../lib/codex-approvals-api.js";
import { useEventStore } from "../stores/event-store.js";

export interface ApprovalsData {
	list: CodexApprovalList | null;
	/** The list answered 403 `not_owner`: this viewer can't read the session's approvals. */
	notOwner: boolean;
	/** The last list fetch failed and nothing is loaded. */
	failed: boolean;
	/** `performance.now()` and `Date.now()` when the list arrived, to anchor each row's countdown. */
	fetchedAtMono: number;
	fetchedAtWall: number;
	kept: ReadonlyMap<string, CodexApprovalSummary>;
}

const EMPTY: ApprovalsData = {
	list: null,
	notOwner: false,
	failed: false,
	fetchedAtMono: 0,
	fetchedAtWall: 0,
	kept: new Map(),
};

/**
 * The approvals for one managed Codex session: the list, the detail of the card on screen, and the
 * rules for when to fetch again. No timer of its own for fetching: the session page's 10 s poll
 * changes `session`, a live update changes it too, and `shouldRefetchOnSession` decides whether
 * that is worth a request. The one timer here is the 1 s countdown, and it runs only while a
 * request is open.
 */
export function useCodexApprovals(session: Session) {
	const sessionId = session.sessionId;
	const [data, setData] = useState<ApprovalsData>(EMPTY);
	const [detail, setDetail] = useState<CodexApprovalDetail | null>(null);
	const [detailFailed, setDetailFailed] = useState(false);
	const [detailRetry, setDetailRetry] = useState(0);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const [nowMono, setNowMono] = useState(() => performance.now());

	const detailRef = useRef(detail);
	detailRef.current = detail;
	const dataRef = useRef(data);
	dataRef.current = data;
	const dismissedRef = useRef(dismissed);
	dismissedRef.current = dismissed;
	const generation = useRef(0);
	const lastFetchAt = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previousIds = useRef<string[]>([]);

	const fetchList = useCallback(async (): Promise<CodexApprovalList | null> => {
		const mine = generation.current;
		lastFetchAt.current = performance.now();
		try {
			const list = await listCodexApprovals(sessionId);
			if (mine !== generation.current) return null;
			setData((prev) => ({
				list,
				notOwner: false,
				failed: false,
				fetchedAtMono: performance.now(),
				fetchedAtWall: Date.now(),
				kept: updateKept(prev.kept, list.approvals, dismissedRef.current),
			}));
			return list;
		} catch (error) {
			if (mine !== generation.current) return null;
			if (error instanceof ApiError && error.status === 403 && error.code === "not_owner") {
				setData({ ...EMPTY, notOwner: true });
			} else {
				setData((prev) => ({ ...prev, failed: prev.list === null }));
			}
			return null;
		}
	}, [sessionId]);

	/** Fetch now (`force`), or at most once every 2 s. */
	const refresh = useCallback(
		(force = false): Promise<CodexApprovalList | null> => {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			const wait = fetchDelayMs(performance.now() - lastFetchAt.current, force);
			if (wait <= 0) return fetchList();
			timer.current = setTimeout(() => {
				timer.current = null;
				void fetchList();
			}, wait);
			return Promise.resolve(null);
		},
		[fetchList],
	);

	// A new session starts over; the first look is the one that learns whether this viewer can read approvals.
	useEffect(() => {
		generation.current += 1;
		setData(EMPTY);
		setDetail(null);
		setDismissed(new Set());
		previousIds.current = [];
		void fetchList();
		return () => {
			generation.current += 1;
			if (timer.current) clearTimeout(timer.current);
		};
	}, [fetchList]);

	// Ownership changed under an open page: ask again.
	const ownerUserId = session.ownerUserId ?? null;
	const ownerSeen = useRef(ownerUserId);
	useEffect(() => {
		if (ownerSeen.current === ownerUserId) return;
		ownerSeen.current = ownerUserId;
		setData((prev) => (prev.notOwner ? EMPTY : prev));
		void refresh(true);
	}, [ownerUserId, refresh]);

	// The session row changed: the 10 s poll, or a live update. Fetch only when it can matter.
	useEffect(() => {
		const ids = codexApprovalWaitIds(session.metadata);
		const current = dataRef.current;
		const worthIt = shouldRefetchOnSession({
			previousIds: previousIds.current,
			ids,
			listHasRows: (current.list?.approvals.length ?? 0) > 0 || current.kept.size > 0,
			notOwner: current.notOwner,
		});
		previousIds.current = ids;
		if (worthIt) void refresh();
	}, [session, refresh]);

	// A permission event arrived on the live feed.
	const permissionEvents = useEventStore(
		(s) =>
			s.liveEvents.get(sessionId)?.filter((e) => e.category === "permission_event").length ?? 0,
	);
	const seenPermissionEvents = useRef(permissionEvents);
	useEffect(() => {
		if (permissionEvents === seenPermissionEvents.current) return;
		seenPermissionEvents.current = permissionEvents;
		if (!dataRef.current.notOwner) void refresh();
	}, [permissionEvents, refresh]);

	// Coming back to the tab: the countdown may have run out while it was hidden.
	useEffect(() => {
		function onVisible() {
			if (document.visibilityState === "visible" && !dataRef.current.notOwner) void refresh(true);
		}
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [refresh]);

	const rows = useMemo(
		() => splitRows(data.list?.approvals ?? [], data.kept, dismissed),
		[data.list, data.kept, dismissed],
	);
	const current = rows.pending[0] ?? null;

	// The card on screen needs the whole text: fetch its detail when the list names a version we don't hold.
	const currentId = current?.id ?? null;
	const currentHash = current?.presentationHash ?? null;
	const currentRevision = current?.revision ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: detailRetry re-runs the fetch when the person taps Try again
	useEffect(() => {
		if (currentId === null || currentHash === null || currentRevision === null) {
			setDetail(null);
			return;
		}
		if (
			detailMatchesRow(detailRef.current, {
				id: currentId,
				presentationHash: currentHash,
				revision: currentRevision,
			})
		) {
			return;
		}
		const mine = generation.current;
		let cancelled = false;
		setDetailFailed(false);
		getCodexApproval(sessionId, currentId)
			.then((fetched) => {
				if (cancelled || mine !== generation.current) return;
				setDetail(fetched);
			})
			.catch(() => {
				if (!cancelled && mine === generation.current) setDetailFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, currentId, currentHash, currentRevision, detailRetry]);

	// The countdown ticks once a second while a request is open.
	const open = current !== null;
	useEffect(() => {
		if (!open) return;
		setNowMono(performance.now());
		const id = setInterval(() => setNowMono(performance.now()), 1000);
		return () => clearInterval(id);
	}, [open]);

	const dismiss = useCallback((id: string) => {
		setDismissed((prev) => new Set(prev).add(id));
		setData((prev) => ({ ...prev, kept: updateKept(prev.kept, [], new Set([id])) }));
	}, []);

	/** The answer came back: show that row's new state now, before the next list. */
	const applyAnswered = useCallback((answered: CodexApprovalSummary) => {
		setData((prev) =>
			prev.list
				? {
						...prev,
						list: {
							...prev.list,
							approvals: prev.list.approvals.map((row) =>
								row.id === answered.id ? answered : row,
							),
						},
						kept: updateKept(prev.kept, [answered], dismissedRef.current),
					}
				: prev,
		);
	}, []);

	return {
		data,
		detail,
		detailFailed,
		retryDetail: () => setDetailRetry((n) => n + 1),
		rows,
		nowMono,
		refresh,
		dismiss,
		applyAnswered,
	};
}
