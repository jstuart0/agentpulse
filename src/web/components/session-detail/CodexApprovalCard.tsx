import { useEffect, useId, useRef, useState } from "react";
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
	CANNOT_ACCEPT_TEXT,
	type FrozenConfirm,
	HOST_GONE_TEXT,
	type ListContext,
	NON_ASCII_HINT,
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
	detailMatchesRow,
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
	requestHeading,
	secondsLeft,
	signedDiffLines,
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
const BUTTON =
	"min-h-[44px] rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:min-h-0";

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

type Dialog =
	| { kind: "approve"; frozen: FrozenConfirm; error: string | null; busy: boolean }
	| { kind: "stop"; approvalId: string; error: string | null; busy: boolean };

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
	const [actionError, setActionError] = useState<string | null>(null);
	const [assertive, setAssertive] = useState("");
	const focusAfter = useRef<string | null>(null);

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
			setAssertive(
				arrivalAnnouncement({
					requestKind: first.requestKind,
					fileCount: first.preview?.fileCount ?? 0,
					declinesAt: clock(data.fetchedAtWall + first.expiresInSeconds * 1000),
					pendingCount: rows.pending.length,
				}),
			);
		}
	}, [rows.pending, data.fetchedAtWall]);
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
			setAssertive(twoMinuteAnnouncement(declinesAt));
		}
	}, [current, left, declinesAt]);
	useEffect(() => {
		for (const row of [...rows.pending, ...rows.settled]) {
			const was = outcomes.current.get(row.id);
			outcomes.current.set(row.id, row.outcome);
			if (row.outcome && was !== undefined && was !== row.outcome) {
				announce(outcomeLine(row.outcome, host, clockOf(outcomeTimeSource(row.outcome, row))));
			}
		}
	}, [rows, host, announce]);

	// After an answer the button that had focus is gone: land on the outcome line, else the next card's heading.
	useEffect(() => {
		const id = focusAfter.current;
		if (!id) return;
		const target =
			document.getElementById(id) ??
			(current ? document.getElementById(approvalHeadingId(current.id)) : null);
		if (target) {
			target.focus();
			focusAfter.current = null;
		}
	});

	const hint = sessionIsLive(session)
		? availabilityHint(session.managedSession?.providerCapabilitySnapshot, host)
		: null;
	const hintNode = hint ? (
		<p className="mx-3 mt-2 text-[11px] leading-relaxed text-muted-foreground md:mx-6 md:mt-3">
			{hint}
		</p>
	) : null;
	const region = (
		<div aria-live="assertive" aria-atomic="true" className="sr-only">
			{assertive}
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
	): Promise<{ ok: true } | { ok: false; message: string; settled: boolean }> {
		try {
			const answered = await answerCodexApproval(
				session.sessionId,
				approval.id,
				decisionBody(decision, frozen),
			);
			applyAnswered(answered.approval);
			focusAfter.current = approvalOutcomeFocusId(approval.id);
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
			if (!view.stale) return { ok: false, message: view.text, settled: false };
			const list = await refresh(true);
			// An answer that may have landed: the row's own state is the truth, not our guess.
			const row = list?.approvals.find((r) => r.id === approval.id);
			const settled = view.unconfirmed && Boolean(row && row.state !== "pending");
			if (settled) focusAfter.current = approvalOutcomeFocusId(approval.id);
			return { ok: false, message: view.text, settled };
		}
	}

	async function decline(approval: CodexApprovalSummary, decision: "decline" | "cancel") {
		setActionError(null);
		const result = await send(approval, decision, null);
		if (!result.ok && !result.settled) setActionError(result.message);
	}

	async function confirmDialog() {
		if (!dialog || !dialogRow) return;
		setDialog({ ...dialog, busy: true, error: null });
		const result =
			dialog.kind === "approve"
				? await send(dialogRow, "accept", dialog.frozen)
				: await send(dialogRow, "cancel", null);
		if (result.ok || result.settled) {
			setDialog(null);
			return;
		}
		setDialog((d) => (d ? { ...d, busy: false, error: result.message } : d));
	}

	function openApprove(row: CodexApprovalSummary, loaded: CodexApprovalDetail) {
		const frozen = freezeConfirm(loaded);
		if (!frozen || frozen.approvalId !== row.id) return;
		setActionError(null);
		setDialog({ kind: "approve", frozen, error: null, busy: false });
	}

	const headingFor = (row: CodexApprovalSummary) => approvalHeadingId(row.id);

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

				{current ? (
					<PendingCard
						key={current.id}
						approval={current}
						index={1}
						total={rows.pending.length}
						ctx={listCtx}
						host={host}
						detail={detailMatchesRow(detail, current) ? detail : null}
						detailFailed={detailFailed}
						onRetryDetail={retryDetail}
						secondsRemaining={left}
						declinesAt={declinesAt}
						headingId={headingFor(current)}
						actionError={actionError}
						onApprove={(loaded) => openApprove(current, loaded)}
						onDecline={() => void decline(current, "decline")}
						onStop={() => {
							setActionError(null);
							setDialog({ kind: "stop", approvalId: current.id, error: null, busy: false });
						}}
					/>
				) : null}

				{rows.settled.map((row) => (
					<SettledRow key={row.id} row={row} host={host} onDismiss={() => dismiss(row.id)} />
				))}
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
	actionError: string | null;
	onApprove: (detail: CodexApprovalDetail) => void;
	onDecline: () => void;
	onStop: () => void;
}

function PendingCard(props: PendingProps) {
	const { approval, ctx, host, detail, secondsRemaining, declinesAt } = props;
	const [expanded, setExpanded] = useState(false);
	const state = cardStateOf(ctx, approval);
	const offers = offersOf(state, approval.canCancel);
	const preview = approval.preview;
	const presentation = detail?.presentation ?? null;
	const cwd = presentation?.cwd ?? preview?.cwd ?? null;
	const answerable = state !== "host_offline" && state !== "host_gone";

	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-2">
				<h2
					id={props.headingId}
					tabIndex={-1}
					className="text-sm font-semibold text-foreground focus:outline-none"
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

			{state === "host_offline" ? (
				<p className="text-sm text-foreground">{hostOfflineText(host, declinesAt)}</p>
			) : null}
			{state === "host_gone" ? <p className="text-sm text-foreground">{HOST_GONE_TEXT}</p> : null}
			{state === "not_approvable" ? (
				<p className="text-sm text-foreground">
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
					capped={state === "not_approvable"}
					expanded={expanded}
					onToggleExpanded={() => setExpanded((v) => !v)}
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
					<summary className="min-h-[44px] cursor-pointer py-2 md:min-h-0 md:py-0">
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
				<p role="alert" className="text-sm text-red-700 dark:text-red-400">
					{props.actionError}
				</p>
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
					{offers.approve && detail ? (
						<button
							type="button"
							onClick={() => props.onApprove(detail)}
							className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
						>
							Approve
						</button>
					) : null}
					{offers.decline ? (
						<button
							type="button"
							onClick={props.onDecline}
							className={`${BUTTON} border border-border text-foreground hover:bg-accent`}
						>
							Decline
						</button>
					) : null}
					{offers.stop ? (
						<details className="text-sm">
							<summary className="min-h-[44px] cursor-pointer px-2 py-2 text-muted-foreground md:min-h-0">
								More
							</summary>
							<button
								type="button"
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

function RequestBody({
	approval,
	presentation,
	capped,
	expanded,
	onToggleExpanded,
}: {
	approval: CodexApprovalSummary;
	presentation: CodexApprovalPresentation | null;
	capped: boolean;
	expanded: boolean;
	onToggleExpanded: () => void;
}) {
	const preview = approval.preview;
	if (presentation?.requestKind === "file_change") {
		return (
			<div className="space-y-1">
				{presentation.changes.map((change, i) => (
					<details key={`${i}:${change.path}`} className="rounded-md border border-border">
						<summary className="min-h-[44px] cursor-pointer break-words px-2 py-2 text-xs text-foreground md:min-h-0">
							{changeSummary(change)}
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
				))}
			</div>
		);
	}
	if (presentation?.requestKind === "command") {
		const command = presentation.command ?? "";
		const lines = command === "" ? 0 : command.split("\n").length;
		// A request that can be approved is shown whole. Only one that can just be declined is cut short.
		const cut = capped && !expanded && lines > CAPPED_LINES;
		return (
			<div className="space-y-1">
				<p className="text-xs text-muted-foreground">{commandStats(command)}</p>
				<pre
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
					tabIndex={0}
					aria-label="Command"
					className={`${PRE_CLASS} ${cut ? "max-h-28" : ""}`}
				>
					{markBlankRuns(command)}
				</pre>
				{capped && lines > CAPPED_LINES ? (
					<button
						type="button"
						onClick={onToggleExpanded}
						className="min-h-[44px] text-xs font-medium text-primary underline underline-offset-2 md:min-h-0"
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
		return <pre className={`${PRE_CLASS} max-h-28`}>{markBlankRuns(preview.commandHead)}</pre>;
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
	const text = outcomeLine(row.outcome, host, clockOf(outcomeTimeSource(row.outcome, row)));
	return (
		<div className="flex items-start justify-between gap-2 border-t border-border pt-2">
			<p
				id={approvalOutcomeFocusId(row.id)}
				tabIndex={-1}
				className="min-w-0 flex-1 text-sm text-foreground focus:outline-none"
			>
				{text}
			</p>
			{isOutcomeFinal(row.outcome) ? (
				<button
					type="button"
					onClick={onDismiss}
					className="min-h-[44px] flex-shrink-0 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground md:min-h-0"
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
	onCancel: () => void;
}) {
	const bodyId = useId();
	if (dialog.kind === "stop") {
		return (
			<ConfirmDialog
				title={STOP_CONFIRM_TITLE}
				confirmLabel="Decline and stop"
				cancelLabel="Back"
				focusCancel
				busy={dialog.busy}
				error={dialog.error}
				fallbackFocusId={fallbackFocusId}
				onConfirm={onConfirm}
				onCancel={onCancel}
			>
				<p>{STOP_CONFIRM_BODY}</p>
			</ConfirmDialog>
		);
	}
	const { frozen } = dialog;
	const event = midConfirmEvent(frozen, row, secondsRemaining);
	const view = event ? midConfirmView(event) : null;
	const presentation = frozen.presentation;
	const files = presentation.requestKind === "file_change" ? presentation.changes : [];
	const copy = confirmCopy({
		requestKind: frozen.requestKind,
		fileCount: files.length,
		host,
		declinesAt,
		owner: showOwner ? owner : null,
	});
	const summary = filesSummary(files);
	return (
		<ConfirmDialog
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			cancelLabel={view?.cancelLabel ?? copy.cancelLabel}
			focusCancel
			busy={dialog.busy}
			confirmDisabled={event !== null}
			error={view?.text ?? dialog.error}
			fallbackFocusId={fallbackFocusId}
			onConfirm={onConfirm}
			onCancel={onCancel}
		>
			{presentation.requestKind === "command" ? (
				<div className="space-y-2" id={bodyId}>
					<p>{commandStats(presentation.command ?? "")}</p>
					<pre className={`${PRE_CLASS} max-h-40`}>{commandTail(presentation.command ?? "")}</pre>
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
		</ConfirmDialog>
	);
}
