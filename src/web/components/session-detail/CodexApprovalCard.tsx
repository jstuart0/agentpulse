import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
	ApprovalDecision,
	CodexApprovalDetail,
	CodexApprovalPresentation,
	CodexApprovalSummary,
} from "../../../shared/codex-approvals.js";
import type { Session } from "../../../shared/types.js";
import { useCodexApprovals } from "../../hooks/useCodexApprovals.js";
import { useOwnershipUi } from "../../hooks/useOwnershipUi.js";
import { describeApprovalError } from "../../lib/approval-errors.js";
import { hasPendingCodexApproval } from "../../lib/codex-approval-wait.js";
import { answerCodexApproval } from "../../lib/codex-approvals-api.js";
import { ownerLabel } from "../../lib/owner-label.js";
import { parseDate } from "../../lib/utils.js";
import { useUserStore } from "../../stores/user-store.js";
import { useUsersStore } from "../../stores/users-store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import {
	ARM_AFTER_MS,
	CANNOT_ACCEPT_TEXT,
	CHECK_FAILED_TEXT,
	type FrozenConfirm,
	HOST_GONE_TEXT,
	type ListContext,
	MAY_HAVE_RUN_LEAD,
	NEXT_REQUEST_LINE,
	NON_ASCII_HINT,
	OUTSIDE_LABEL,
	REVISION_CHANGED_LINE,
	STILL_OPEN_TEXT,
	STOP_CONFIRM_BODY,
	STOP_CONFIRM_TITLE,
	approvalHeadingId,
	approvalOutcomeFocusId,
	arrivalAnnouncement,
	availabilityHint,
	cardStateOf,
	changeSummary,
	commandStats,
	commandTail,
	confirmCopy,
	countdownText,
	crossedTwoMinutes,
	decisionBody,
	defaultDiffsOpen,
	detailMatchesRow,
	diffDeltaLabel,
	filesSummary,
	freezeConfirm,
	hostLabel,
	hostOfflineText,
	isOutcomeFinal,
	isUrgent,
	markBlankRuns,
	metaLine,
	midConfirmEvent,
	midConfirmView,
	newlyPending,
	notApprovableText,
	offersOf,
	outcomeLine,
	outcomeTimeSource,
	outsideCwdText,
	outsideFirst,
	queuePosition,
	requestHeading,
	secondsLeft,
	showsAvailabilityHint,
	signedDiffLines,
	statsText,
	teamNotOwnerHeading,
	teamNotOwnerLine,
	twoMinuteAnnouncement,
} from "./codex-approval-view.js";

interface Props {
	session: Session;
	/** The page's polite live region. */
	announce: (text: string) => void;
}

const PRE_CLASS =
	"overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-2 font-mono text-xs text-foreground";
// Touch targets shrink only for a fine pointer: a tablet at desktop width is still touched.
const SHRINK = "md:[@media(pointer:fine)]:min-h-0";
const BUTTON = `min-h-[44px] rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${SHRINK}`;
const FOCUS_TARGET = "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A stored timestamp as a clock time; null when it can't be read. */
function clockOf(stored: string | null): string | null {
	if (!stored) return null;
	const ms = parseDate(stored);
	return Number.isNaN(ms) ? null : clock(ms);
}

function sessionIsLive(session: Session): boolean {
	return (
		session.endedAt == null &&
		!session.isArchived &&
		session.status !== "completed" &&
		session.status !== "failed" &&
		session.status !== "archived"
	);
}

interface DialogState {
	error: string | null;
	busy: boolean;
	/** The answer may have landed and the check couldn't say: confirm stays off until a check succeeds. */
	needsCheck: boolean;
}
type Dialog =
	| ({ kind: "approve"; frozen: FrozenConfirm } & DialogState)
	| ({ kind: "stop"; approvalId: string } & DialogState);

type Unanswered = { ok: false; message: string; settled: boolean; needsCheck: boolean };
type SendResult = { ok: true } | Unanswered;

/** Taps are ignored for `ms` after mount and after each `disarm()`, so a card that swaps in can't take a tap meant for the last one. */
function useDisarm(ms: number): [boolean, () => void] {
	const [armed, setArmed] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disarm = useCallback(() => {
		setArmed(false);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setArmed(true), ms);
	}, [ms]);
	useEffect(() => {
		disarm();
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [disarm]);
	return [armed, disarm];
}

/** Speaks into a live region so the same words twice are heard twice: cleared first, then set. */
function useSpeaker(setter: (text: string) => void): (text: string) => void {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return useCallback(
		(text: string) => {
			setter("");
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setter(text), 60);
		},
		[setter],
	);
}

type FocusRequest = { kind: "answered"; approvalId: string } | { kind: "header" };

/**
 * Codex asks to run a command or change files, and the person answers here (AGEN-87). One request
 * is on screen at a time ("1 of 3"), oldest first, so a tap can't land on a card that just moved.
 * Everything the agent wrote is drawn as text, wrapped, never as markup.
 */
export function CodexApprovalCard({ session, announce }: Props) {
	const {
		data,
		detail,
		detailFailed,
		retryDetail,
		rows,
		nowMono,
		refresh,
		dismiss,
		applyAnswered,
	} = useCodexApprovals(session);
	const ownership = useOwnershipUi();
	const viewerUserId = useUserStore((s) => s.userId);
	const directory = useUsersStore((s) => s.byId);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [actionError, setActionError] = useState<{ text: string; check: boolean } | null>(null);
	const [assertiveText, setAssertive] = useState("");
	const [declining, setDeclining] = useState(false);
	const focusAfter = useRef<FocusRequest | null>(null);
	const inFlight = useRef(false);
	const sayAssertive = useSpeaker(setAssertive);
	const sayPolite = useSpeaker(announce);

	const host = data.list?.host.name ?? session.managedSession?.hostName ?? null;
	const ownerId = session.ownerUserId ?? null;
	const ownerName = ownerId
		? ownerLabel(directory[ownerId], ownerId, { selfId: viewerUserId })
		: null;
	const current = rows.pending[0] ?? null;
	const dialogId = dialog
		? dialog.kind === "approve"
			? dialog.frozen.approvalId
			: dialog.approvalId
		: null;
	const dialogRow =
		dialogId === null
			? null
			: ([...rows.pending, ...rows.settled].find((r) => r.id === dialogId) ?? null);
	const left = current ? secondsLeft(current.expiresInSeconds, data.fetchedAtMono, nowMono) : 0;
	const declinesAt = current ? clock(data.fetchedAtWall + current.expiresInSeconds * 1000) : null;

	// What the person hears. Arrival never moves focus; it only speaks, and never reads the command.
	const announced = useRef(new Set<string>());
	const twoMinuteDone = useRef(new Set<string>());
	const previousLeft = useRef<Record<string, number>>({});
	const outcomes = useRef(new Map<string, string | null>());
	useEffect(() => {
		const fresh = newlyPending(announced.current, rows.pending);
		for (const row of fresh) announced.current.add(row.id);
		if (fresh.length > 0) {
			const first = fresh[0] as CodexApprovalSummary;
			sayAssertive(
				arrivalAnnouncement({
					requestKind: first.requestKind,
					fileCount: first.preview?.fileCount ?? 0,
					declinesAt: clock(data.fetchedAtWall + first.expiresInSeconds * 1000),
					pendingCount: rows.pending.length,
				}),
			);
		}
	}, [rows.pending, data.fetchedAtWall, sayAssertive]);
	useEffect(() => {
		if (!current) return;
		const before = previousLeft.current[current.id];
		previousLeft.current[current.id] = left;
		if (
			before !== undefined &&
			!twoMinuteDone.current.has(current.id) &&
			crossedTwoMinutes(before, left)
		) {
			twoMinuteDone.current.add(current.id);
			sayAssertive(twoMinuteAnnouncement(declinesAt));
		}
	}, [current, left, declinesAt, sayAssertive]);
	useEffect(() => {
		for (const row of [...rows.pending, ...rows.settled]) {
			const was = outcomes.current.get(row.id);
			outcomes.current.set(row.id, row.outcome);
			if (row.outcome && was !== undefined && was !== row.outcome) {
				sayPolite(
					outcomeLine(
						row.outcome,
						host,
						clockOf(outcomeTimeSource(row.outcome, row)),
						row.decision,
					),
				);
			}
		}
	}, [rows, host, sayPolite]);

	// The clock reached zero: the server decides what that meant, so ask it (once per request).
	const zeroFetched = useRef(new Set<string>());
	useEffect(() => {
		if (!current) return;
		if (left > 0) {
			zeroFetched.current.delete(current.id);
		} else if (!zeroFetched.current.has(current.id)) {
			zeroFetched.current.add(current.id);
			void refresh(true);
		}
	}, [current, left, refresh]);

	// "2 of 3" counts requests seen in this run, so answering one moves the number on.
	const seen = useRef(new Set<string>());
	const position = queuePosition(
		seen.current,
		rows.pending.map((r) => r.id),
	);
	useEffect(() => {
		seen.current =
			rows.pending.length === 0
				? new Set()
				: queuePosition(
						seen.current,
						rows.pending.map((r) => r.id),
					).universe;
	}, [rows.pending]);

	// A card replacing another says so, and its answer stays visible below.
	const currentId = current?.id ?? null;
	const previousCurrentId = useRef<string | null>(null);
	const [swappedFrom, setSwappedFrom] = useState<string | null>(null);
	useEffect(() => {
		const before = previousCurrentId.current;
		previousCurrentId.current = currentId;
		if (currentId === before) return;
		setActionError(null);
		if (currentId === null) setSwappedFrom(null);
		else if (before !== null) setSwappedFrom(before);
	}, [currentId]);

	// After an answer the button that had focus is gone: land on the next card's heading when there is
	// one, else on the outcome line. After Dismiss, on the session header.
	useEffect(() => {
		const request = focusAfter.current;
		if (!request) return;
		if (request.kind === "header") {
			focusAfter.current = null;
			requestAnimationFrame(() =>
				document.querySelector<HTMLElement>("[data-session-header]")?.focus(),
			);
			return;
		}
		const next = current && current.id !== request.approvalId ? current : null;
		const target = next
			? document.getElementById(approvalHeadingId(next.id))
			: (document.getElementById(approvalOutcomeFocusId(request.approvalId)) ??
				(current ? document.getElementById(approvalHeadingId(current.id)) : null));
		if (target) {
			target.focus();
			focusAfter.current = null;
		}
	});

	const hint =
		sessionIsLive(session) && showsAvailabilityHint(session.managedSession)
			? availabilityHint(session.managedSession?.providerCapabilitySnapshot, host)
			: null;
	const hintNode = hint ? (
		<p className="mx-3 mt-2 text-xs leading-relaxed text-muted-foreground md:mx-6 md:mt-3">
			{hint}
		</p>
	) : null;
	const region = (
		<div aria-live="assertive" aria-atomic="true" className="sr-only">
			{assertiveText}
		</div>
	);

	if (data.notOwner) {
		return (
			<div className="flex-shrink-0">
				{region}
				{hasPendingCodexApproval(session) ? (
					<section
						data-codex-approval=""
						aria-label="Codex approval"
						className="mx-3 mt-2 rounded-lg border border-border bg-card p-3 md:mx-6 md:mt-3"
					>
						<h2 className="text-sm font-semibold text-foreground">
							{teamNotOwnerHeading(ownerName)}
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">{teamNotOwnerLine(ownerName)}</p>
					</section>
				) : null}
				{hintNode}
			</div>
		);
	}

	const showFailed = data.failed && hasPendingCodexApproval(session);
	const nothingToShow = !current && rows.settled.length === 0 && !showFailed;
	if (nothingToShow) {
		return (
			<div className="flex-shrink-0">
				{region}
				{hintNode}
			</div>
		);
	}

	const listCtx: ListContext = {
		notOwner: false,
		host: data.list?.host ?? null,
		viewer: data.list?.viewer ?? null,
	};

	async function send(
		approval: CodexApprovalSummary,
		decision: ApprovalDecision,
		frozen: FrozenConfirm | null,
	): Promise<SendResult> {
		try {
			const answered = await answerCodexApproval(
				session.sessionId,
				approval.id,
				decisionBody(decision, frozen),
			);
			applyAnswered(answered.approval);
			focusAfter.current = { kind: "answered", approvalId: approval.id };
			void refresh(true);
			return { ok: true };
		} catch (error) {
			const view = describeApprovalError(error, {
				host,
				owner: ownerName,
				declinesAt,
				reason: approval.notApprovableReason,
				grantRoot: grantRootOf(detail?.presentation ?? null),
			});
			if (!view.stale) return { ok: false, message: view.text, settled: false, needsCheck: false };
			const list = await refresh(true);
			// An answer that may have landed: the row's own state is the truth, not our guess.
			const row = list?.approvals.find((r) => r.id === approval.id);
			if (!view.unconfirmed)
				return { ok: false, message: view.text, settled: false, needsCheck: false };
			if (row && row.state !== "pending") {
				focusAfter.current = { kind: "answered", approvalId: approval.id };
				return { ok: false, message: view.text, settled: true, needsCheck: false };
			}
			const checked = Boolean(row);
			return {
				ok: false,
				message: checked ? STILL_OPEN_TEXT : CHECK_FAILED_TEXT,
				settled: false,
				needsCheck: !checked,
			};
		}
	}

	/** Reads the list again for a row whose answer was never confirmed. */
	async function recheck(approvalId: string): Promise<Unanswered> {
		const list = await refresh(true);
		const row = list?.approvals.find((r) => r.id === approvalId);
		if (row && row.state !== "pending") {
			focusAfter.current = { kind: "answered", approvalId };
			return { ok: false, message: "", settled: true, needsCheck: false };
		}
		return {
			ok: false,
			message: row ? STILL_OPEN_TEXT : CHECK_FAILED_TEXT,
			settled: false,
			needsCheck: !row,
		};
	}

	async function decline(approval: CodexApprovalSummary, decision: "decline" | "cancel") {
		if (inFlight.current) return;
		inFlight.current = true;
		setDeclining(true);
		setActionError(null);
		try {
			const result = await send(approval, decision, null);
			if (!result.ok && !result.settled) {
				setActionError({ text: result.message, check: result.needsCheck });
			}
		} finally {
			inFlight.current = false;
			setDeclining(false);
		}
	}

	async function checkDeclineAgain(approvalId: string) {
		if (inFlight.current) return;
		inFlight.current = true;
		setDeclining(true);
		try {
			const result = await recheck(approvalId);
			setActionError(result.settled ? null : { text: result.message, check: result.needsCheck });
		} finally {
			inFlight.current = false;
			setDeclining(false);
		}
	}

	async function confirmDialog() {
		if (!dialog || !dialogRow || inFlight.current || dialog.needsCheck) return;
		inFlight.current = true;
		setDialog({ ...dialog, busy: true, error: null });
		try {
			const result =
				dialog.kind === "approve"
					? await send(dialogRow, "accept", dialog.frozen)
					: await send(dialogRow, "cancel", null);
			if (result.ok || result.settled) {
				setDialog(null);
				return;
			}
			setDialog((d) =>
				d ? { ...d, busy: false, error: result.message, needsCheck: result.needsCheck } : d,
			);
		} finally {
			inFlight.current = false;
		}
	}

	async function checkDialogAgain() {
		if (!dialog || !dialogId || inFlight.current) return;
		inFlight.current = true;
		setDialog({ ...dialog, busy: true });
		try {
			const result = await recheck(dialogId);
			if (result.settled) {
				setDialog(null);
				return;
			}
			setDialog((d) =>
				d ? { ...d, busy: false, error: result.message, needsCheck: result.needsCheck } : d,
			);
		} finally {
			inFlight.current = false;
		}
	}

	function openApprove(row: CodexApprovalSummary, loaded: CodexApprovalDetail) {
		const frozen = freezeConfirm(loaded);
		if (!frozen || frozen.approvalId !== row.id) return;
		setActionError(null);
		setDialog({ kind: "approve", frozen, error: null, busy: false, needsCheck: false });
	}

	const headingFor = (row: CodexApprovalSummary) => approvalHeadingId(row.id);
	const mayHaveRun = rows.settled.filter((r) => r.outcome === "may_have_run");
	const otherSettled = rows.settled.filter((r) => r.outcome !== "may_have_run");
	const renderSettled = (row: CodexApprovalSummary) => (
		<SettledRow
			key={row.id}
			row={row}
			host={host}
			onDismiss={() => {
				focusAfter.current = { kind: "header" };
				dismiss(row.id);
			}}
		/>
	);

	return (
		<div className="flex-shrink-0">
			{region}
			<section
				data-codex-approval=""
				aria-label="Codex approval"
				className="mx-3 mt-2 space-y-2 rounded-lg border border-primary/40 bg-card p-3 md:mx-6 md:mt-3"
			>
				{showFailed ? (
					<div className="space-y-2">
						<p role="alert" className="text-sm text-foreground">
							Codex is asking for approval, but AgentPulse couldn't load it.
						</p>
						<button
							type="button"
							onClick={() => void refresh(true)}
							className={`${BUTTON} border border-border text-foreground hover:bg-accent`}
						>
							Try again
						</button>
					</div>
				) : null}

				{mayHaveRun.map(renderSettled)}

				{current && swappedFrom && rows.settled.some((r) => r.id === swappedFrom) ? (
					<p className="text-sm text-muted-foreground">{NEXT_REQUEST_LINE}</p>
				) : null}

				{current ? (
					<PendingCard
						key={current.id}
						approval={current}
						index={position.index}
						total={position.total}
						ctx={listCtx}
						host={host}
						detail={detailMatchesRow(detail, current) ? detail : null}
						detailFailed={detailFailed}
						onRetryDetail={retryDetail}
						secondsRemaining={left}
						declinesAt={declinesAt}
						headingId={headingFor(current)}
						actionError={actionError}
						declining={declining}
						announce={sayPolite}
						onCheckAgain={() => void checkDeclineAgain(current.id)}
						onApprove={(loaded) => openApprove(current, loaded)}
						onDecline={() => void decline(current, "decline")}
						onStop={() => {
							setActionError(null);
							setDialog({
								kind: "stop",
								approvalId: current.id,
								error: null,
								busy: false,
								needsCheck: false,
							});
						}}
					/>
				) : null}

				{otherSettled.map(renderSettled)}
			</section>

			{hintNode}

			{dialog && dialogId ? (
				<DialogFor
					dialog={dialog}
					row={dialogRow}
					host={host}
					owner={ownerName}
					showOwner={
						ownership.ownerGatesSessionActions && ownerId !== null && ownerId !== viewerUserId
					}
					declinesAt={declinesAt}
					secondsRemaining={left}
					fallbackFocusId={approvalOutcomeFocusId(dialogId)}
					onConfirm={() => void confirmDialog()}
					onCheckAgain={() => void checkDialogAgain()}
					onCancel={() => setDialog(null)}
				/>
			) : null}
		</div>
	);
}

function grantRootOf(presentation: CodexApprovalPresentation | null): string | null {
	return presentation?.grantRoot ?? null;
}

// ── the open request ────────────────────────────────────────────────────────

interface PendingProps {
	approval: CodexApprovalSummary;
	index: number;
	total: number;
	ctx: ListContext;
	host: string | null;
	detail: CodexApprovalDetail | null;
	detailFailed: boolean;
	onRetryDetail: () => void;
	secondsRemaining: number;
	declinesAt: string | null;
	headingId: string;
	actionError: { text: string; check: boolean } | null;
	declining: boolean;
	announce: (text: string) => void;
	onCheckAgain: () => void;
	onApprove: (detail: CodexApprovalDetail) => void;
	onDecline: () => void;
	onStop: () => void;
}

function PendingCard(props: PendingProps) {
	const { approval, ctx, host, detail, secondsRemaining, declinesAt, announce } = props;
	const [expanded, setExpanded] = useState(false);
	const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
	const [armed, disarm] = useDisarm(ARM_AFTER_MS);
	const [changed, setChanged] = useState(false);
	const version = `${approval.revision}:${approval.presentationHash}`;
	const seenVersion = useRef(version);
	// The same request, asked differently: say so, and keep the buttons off for a moment.
	useEffect(() => {
		if (seenVersion.current === version) return;
		seenVersion.current = version;
		setChanged(true);
		disarm();
		announce(REVISION_CHANGED_LINE);
	}, [version, disarm, announce]);
	const state = cardStateOf(ctx, approval);
	const offers = offersOf(state, approval.canCancel);
	const preview = approval.preview;
	const presentation = detail?.presentation ?? null;
	const cwd = presentation?.cwd ?? preview?.cwd ?? null;
	const answerable = state !== "host_offline" && state !== "host_gone";
	const outsideFlags = Array.isArray(detail?.outsideCwd) ? detail.outsideCwd : null;

	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-2">
				<h2
					id={props.headingId}
					tabIndex={-1}
					className={`text-sm font-semibold text-foreground ${FOCUS_TARGET}`}
				>
					{requestHeading(approval)}
				</h2>
				{props.total > 1 ? (
					<span className="flex-shrink-0 text-xs text-muted-foreground">
						{props.index} of {props.total}
					</span>
				) : null}
			</div>
			<p
				className="truncate text-xs text-muted-foreground"
				title={cwd ? `${hostLabel(host)} · ${cwd}` : undefined}
			>
				{metaLine(host, cwd)}
			</p>

			{changed ? (
				<p className="text-sm font-semibold text-foreground">{REVISION_CHANGED_LINE}</p>
			) : null}

			{state === "host_offline" ? (
				<p className="break-words text-sm text-foreground">{hostOfflineText(host, declinesAt)}</p>
			) : null}
			{state === "host_gone" ? <p className="text-sm text-foreground">{HOST_GONE_TEXT}</p> : null}
			{state === "not_approvable" ? (
				<p className="break-words text-sm text-foreground">
					{notApprovableText(approval.notApprovableReason, host, grantRootOf(presentation))}
				</p>
			) : null}
			{state === "cannot_accept" ? (
				<p className="text-sm text-foreground">{CANNOT_ACCEPT_TEXT}</p>
			) : null}

			{answerable ? (
				<RequestBody
					approval={approval}
					presentation={presentation}
					outsideFlags={outsideFlags}
					capped={state === "not_approvable"}
					expanded={expanded}
					onToggleExpanded={() => setExpanded((v) => !v)}
					openFiles={openFiles}
					onToggleFile={(key, open) => setOpenFiles((prev) => ({ ...prev, [key]: open }))}
				/>
			) : null}

			{answerable && preview?.nonAscii ? (
				<p className="text-xs font-medium text-foreground">{NON_ASCII_HINT}</p>
			) : null}
			{answerable && preview?.pathOutsideCwd ? (
				<p className="text-sm font-semibold text-red-700 dark:text-red-400">
					{outsideCwdText(cwd)}
				</p>
			) : null}

			{answerable && detail?.reasonText ? (
				<details className="text-xs text-muted-foreground">
					<summary className={`min-h-[44px] cursor-pointer py-2 ${SHRINK} md:py-0`}>
						Codex says:
					</summary>
					<p className="mt-1 whitespace-pre-wrap break-words">{detail.reasonText}</p>
				</details>
			) : null}

			{answerable ? (
				<p
					className={`text-sm ${isUrgent(secondsRemaining) ? "font-semibold text-red-700 dark:text-red-400" : "text-foreground"}`}
				>
					{countdownText(declinesAt, secondsRemaining)}
				</p>
			) : null}

			{props.actionError ? (
				<div className="space-y-2">
					<p role="alert" className="break-words text-sm text-red-700 dark:text-red-400">
						{props.actionError.text}
					</p>
					{props.actionError.check ? (
						<button
							type="button"
							onClick={props.onCheckAgain}
							disabled={props.declining}
							className={`${BUTTON} border border-border text-foreground hover:bg-accent`}
						>
							Check again
						</button>
					) : null}
				</div>
			) : null}

			{props.detailFailed && answerable ? (
				<div className="flex flex-wrap items-center gap-2">
					<p className="text-sm text-foreground">The full request didn't load.</p>
					<button
						type="button"
						onClick={props.onRetryDetail}
						className={`${BUTTON} border border-border text-foreground hover:bg-accent`}
					>
						Try again
					</button>
				</div>
			) : null}
			{!detail && !props.detailFailed && answerable && offers.approve ? (
				<p className="text-xs text-muted-foreground">Loading the full request…</p>
			) : null}

			{offers.approve || offers.decline ? (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					{offers.approve ? (
						// The slot stays while the request loads, so Decline never slides under a tap meant for Approve.
						<button
							type="button"
							disabled={!armed || !detail}
							onClick={() => (detail ? props.onApprove(detail) : undefined)}
							className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
						>
							Approve
						</button>
					) : null}
					{offers.decline ? (
						<button
							type="button"
							disabled={!armed || props.declining}
							onClick={props.onDecline}
							className={`${BUTTON} border border-border text-foreground hover:bg-accent`}
						>
							{props.declining ? "Declining…" : "Decline"}
						</button>
					) : null}
					{offers.stop ? (
						<details className="text-sm">
							<summary
								className={`min-h-[44px] cursor-pointer px-2 py-2 text-muted-foreground ${SHRINK}`}
							>
								More
							</summary>
							<button
								type="button"
								disabled={!armed || props.declining}
								onClick={props.onStop}
								className={`${BUTTON} mt-1 border border-border text-foreground hover:bg-accent`}
							>
								Decline and stop the turn
							</button>
						</details>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function CommandLines({ text }: { text: string }) {
	// One block per logical line with a hanging indent, so a wrapped line can't pass for a new one.
	return text.split("\n").map((line, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: the lines of a fixed string have no other identity
		<span key={i} className="block pl-4 -indent-4">
			{line === "" ? " " : line}
		</span>
	));
}

function RequestBody({
	approval,
	presentation,
	outsideFlags,
	capped,
	expanded,
	onToggleExpanded,
	openFiles,
	onToggleFile,
}: {
	approval: CodexApprovalSummary;
	presentation: CodexApprovalPresentation | null;
	outsideFlags: boolean[] | null;
	capped: boolean;
	expanded: boolean;
	onToggleExpanded: () => void;
	openFiles: Record<string, boolean>;
	onToggleFile: (key: string, open: boolean) => void;
}) {
	const preview = approval.preview;
	if (presentation?.requestKind === "file_change") {
		const flags =
			outsideFlags && outsideFlags.length === presentation.changes.length ? outsideFlags : null;
		const order = outsideFirst(presentation.changes.length, flags);
		const defaults = defaultDiffsOpen(order.map((i) => presentation.changes[i] as never));
		return (
			<div className="space-y-1">
				{order.map((i, position) => {
					const change = presentation.changes[i] as (typeof presentation.changes)[number];
					const key = `${i}:${change.path}`;
					const outside = flags?.[i] === true;
					const delta = diffDeltaLabel(change.kind, change.diff);
					return (
						<details
							key={key}
							open={openFiles[key] ?? defaults[position]}
							onToggle={(e) => onToggleFile(key, e.currentTarget.open)}
							className={`rounded-md border ${outside ? "border-red-700/60 dark:border-red-400/60" : "border-border"}`}
						>
							<summary
								className={`min-h-[44px] cursor-pointer break-words px-2 py-2 text-xs text-foreground ${SHRINK}`}
							>
								{outside ? (
									<strong className="block text-red-700 dark:text-red-400">{OUTSIDE_LABEL}</strong>
								) : null}
								{changeSummary(change)}
								{delta ? (
									<span className="ml-2 whitespace-nowrap font-mono text-muted-foreground">
										{delta}
									</span>
								) : null}
							</summary>
							<pre
								// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
								tabIndex={0}
								aria-label={`Changes to ${change.path}`}
								className={`${PRE_CLASS} m-1 max-h-72`}
							>
								{signedDiffLines(change.kind, change.diff).join("\n")}
							</pre>
						</details>
					);
				})}
			</div>
		);
	}
	if (presentation?.requestKind === "command") {
		const command = presentation.command ?? "";
		// Nothing to show for a request with no command: no count, no empty box.
		if (command === "") return null;
		// What is drawn: a long gap is one marker line, so the count and the cut are judged on that.
		const drawn = markBlankRuns(command);
		const lines = drawn.split("\n").length;
		// A request that can be approved is shown whole. Only one that can just be declined is cut short.
		const cut = capped && !expanded && lines > CAPPED_LINES;
		return (
			<div className="space-y-1">
				<p className="text-xs text-muted-foreground">{commandStats(command)}</p>
				<pre
					{...(cut ? { tabIndex: 0, role: "region", "aria-label": "Command" } : {})}
					className={`${PRE_CLASS} ${cut ? "max-h-28" : ""}`}
				>
					<CommandLines text={drawn} />
				</pre>
				{capped && lines > CAPPED_LINES ? (
					<button
						type="button"
						onClick={onToggleExpanded}
						className={`min-h-[44px] text-xs font-medium text-primary underline underline-offset-2 ${SHRINK}`}
					>
						{expanded ? "Show less" : `Show all ${lines} lines`}
					</button>
				) : null}
			</div>
		);
	}
	// Until the whole request is here, only what the list carries, and no way to approve.
	if (preview?.paths) {
		return (
			<ul className="space-y-0.5 text-xs text-foreground">
				{preview.paths.map((p) => (
					<li key={`${p.path}\u0000${p.kind}`} className="break-words">
						{changeSummary({ path: p.path, kind: p.kind, movePath: null })}
					</li>
				))}
			</ul>
		);
	}
	if (preview?.commandHead !== undefined) {
		return (
			<div className="space-y-1">
				{/* The list carries the size, so the line is there before the command is and nothing below moves. */}
				{preview.lineCount !== undefined && preview.charCount !== undefined ? (
					<p className="text-xs text-muted-foreground">
						{statsText(preview.lineCount, preview.charCount)}
					</p>
				) : null}
				<pre className={`${PRE_CLASS} max-h-28`}>
					<CommandLines text={markBlankRuns(preview.commandHead)} />
				</pre>
			</div>
		);
	}
	return null;
}

const CAPPED_LINES = 5;

// ── a row that has been answered or has closed ──────────────────────────────

function SettledRow({
	row,
	host,
	onDismiss,
}: {
	row: CodexApprovalSummary;
	host: string | null;
	onDismiss: () => void;
}) {
	if (!row.outcome) return null;
	const text = outcomeLine(
		row.outcome,
		host,
		clockOf(outcomeTimeSource(row.outcome, row)),
		row.decision,
	);
	const risky = row.outcome === "may_have_run";
	return (
		<div
			className={
				risky
					? "flex items-start justify-between gap-2 rounded-md border-2 border-amber-600 p-2 dark:border-amber-400"
					: "flex items-start justify-between gap-2 border-t border-border pt-2"
			}
		>
			<p
				id={approvalOutcomeFocusId(row.id)}
				tabIndex={-1}
				className={`min-w-0 flex-1 break-words text-sm text-foreground ${FOCUS_TARGET}`}
			>
				{risky && text.startsWith(MAY_HAVE_RUN_LEAD) ? (
					<>
						<strong>{MAY_HAVE_RUN_LEAD}</strong>
						{text.slice(MAY_HAVE_RUN_LEAD.length)}
					</>
				) : (
					text
				)}
			</p>
			{isOutcomeFinal(row.outcome) ? (
				<button
					type="button"
					onClick={onDismiss}
					className={`min-h-[44px] flex-shrink-0 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${SHRINK}`}
				>
					Dismiss
				</button>
			) : null}
		</div>
	);
}

// ── the confirm step ────────────────────────────────────────────────────────

function DialogFor({
	dialog,
	row,
	host,
	owner,
	showOwner,
	declinesAt,
	secondsRemaining,
	fallbackFocusId,
	onConfirm,
	onCheckAgain,
	onCancel,
}: {
	dialog: Dialog;
	row: CodexApprovalSummary | null;
	host: string | null;
	owner: string | null;
	showOwner: boolean;
	declinesAt: string | null;
	secondsRemaining: number;
	fallbackFocusId: string;
	onConfirm: () => void;
	onCheckAgain: () => void;
	onCancel: () => void;
}) {
	const bodyId = useId();
	const checkAgain = dialog.needsCheck ? (
		<button
			type="button"
			onClick={onCheckAgain}
			disabled={dialog.busy}
			className={`${BUTTON} border border-border text-foreground hover:bg-accent`}
		>
			Check again
		</button>
	) : null;
	if (dialog.kind === "stop") {
		return (
			<ConfirmDialog
				title={STOP_CONFIRM_TITLE}
				confirmLabel="Decline and stop"
				cancelLabel="Back"
				focusCancel
				armAfterMs={ARM_AFTER_MS}
				busy={dialog.busy}
				busyLabel="Sending…"
				confirmDisabled={dialog.needsCheck}
				error={dialog.error}
				fallbackFocusId={fallbackFocusId}
				onConfirm={onConfirm}
				onCancel={onCancel}
			>
				<p>{STOP_CONFIRM_BODY}</p>
				{checkAgain}
			</ConfirmDialog>
		);
	}
	const { frozen } = dialog;
	// While the answer is in flight, or may have landed and the check failed, the page's clock and
	// the list say nothing reliable about it: no line about what happened until the server's row does.
	const event =
		dialog.busy || dialog.needsCheck ? null : midConfirmEvent(frozen, row, secondsRemaining);
	const view = event ? midConfirmView(event, row, host, clockOf) : null;
	const presentation = frozen.presentation;
	const files = presentation.requestKind === "file_change" ? presentation.changes : [];
	const copy = confirmCopy({
		requestKind: frozen.requestKind,
		fileCount: files.length,
		host,
		declinesAt,
		owner: showOwner ? owner : null,
	});
	const summary = filesSummary(files, frozen.outsideCwd);
	const outside =
		frozen.preview?.pathOutsideCwd === true || frozen.outsideCwd?.some(Boolean) === true;
	const tail =
		presentation.requestKind === "command" ? commandTail(presentation.command ?? "") : null;
	return (
		<ConfirmDialog
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			cancelLabel={view?.cancelLabel ?? copy.cancelLabel}
			focusCancel
			armAfterMs={ARM_AFTER_MS}
			busy={dialog.busy}
			busyLabel="Sending…"
			confirmDisabled={event !== null || dialog.needsCheck}
			error={view?.text ?? dialog.error}
			fallbackFocusId={fallbackFocusId}
			onConfirm={onConfirm}
			onCancel={onCancel}
		>
			{outside ? (
				<p className="break-words font-semibold text-red-700 dark:text-red-400">
					{outsideCwdText(presentation.cwd)}
				</p>
			) : null}
			{frozen.preview?.nonAscii ? (
				<p className="font-medium text-foreground">{NON_ASCII_HINT}</p>
			) : null}
			{tail ? (
				<div className="space-y-2" id={bodyId}>
					<p>
						{commandStats(
							presentation.requestKind === "command" ? (presentation.command ?? "") : "",
						)}
					</p>
					{tail.label ? <p>{tail.label}</p> : null}
					<pre className={PRE_CLASS}>{tail.text}</pre>
					{presentation.cwd ? <p className="break-words">In {presentation.cwd}</p> : null}
				</div>
			) : (
				<div className="space-y-2" id={bodyId}>
					<ul className="space-y-0.5">
						{summary.listed.map((line) => (
							<li key={line} className="break-words">
								{line}
							</li>
						))}
					</ul>
					{summary.more ? <p>{summary.more}</p> : null}
					{presentation.cwd ? <p className="break-words">In {presentation.cwd}</p> : null}
				</div>
			)}
			{copy.closing.map((line) => (
				<p key={line}>{line}</p>
			))}
			{checkAgain}
		</ConfirmDialog>
	);
}
