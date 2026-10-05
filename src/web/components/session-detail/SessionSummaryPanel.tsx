import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { SessionSummaryView } from "../../../shared/session-summary-view.js";
import type { StoredSessionSummary } from "../../../shared/session-summary.js";
import type { SummaryAnnouncement, UseSessionSummary } from "../../hooks/useSessionSummary.js";
import { useCopyActions, useGenerateClick } from "../../hooks/useSummaryActions.js";
import type { AiStatusResponse } from "../../lib/api.js";
import {
	type ActionState,
	type ClockOptions,
	type RefusalCopy,
	type SummaryLoad,
	type SummaryViewModel,
	type SummaryViewer,
	type SuspectNotice,
	deriveSummaryView,
	footerText,
	formatElapsed,
	formatMoment,
	partialEvidenceNotice,
	relativeAgo,
	shouldFocusHeading,
} from "../../lib/session-summary-view.js";
import type { CopyKind } from "../../lib/summary-copy.js";
import { cn } from "../../lib/utils.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { LabsBadge } from "../LabsBadge.js";
import { CopyBar } from "./CopyFallback.js";
import { SummarySections } from "./SummarySections.js";

export interface SessionSummaryPanelProps {
	sessionId: string;
	agentType: string | null;
	load: SummaryLoad;
	/** Polling gave up: the last view stays, with Retry beside the action. */
	lostContact: boolean;
	refusal: RefusalCopy | null;
	aiStatus: AiStatusResponse | null;
	viewer: SummaryViewer;
	generate: UseSessionSummary["generate"];
	retry: () => void;
	/** A fixed clock, for tests; the browser's own otherwise. */
	clock?: ClockOptions;
	/** The session's name, branch and directory, for the line at the top of copied text. */
	meta?: { name: string | null; branch: string | null; cwd: string | null };
	/** Says something through the page's polite live region. */
	announce?: (text: string) => void;
	/** The hook's announcement, so the heading can take focus when your own generation ends. */
	announcement?: SummaryAnnouncement | null;
}

const FILLED =
	"min-h-[44px] rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 aria-disabled:cursor-not-allowed aria-disabled:bg-muted aria-disabled:text-muted-foreground md:min-h-0";
const QUIET =
	"min-h-[44px] rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent md:min-h-0";
const OUTLINED =
	"min-h-[44px] rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent md:min-h-0";
export const COPIED_LABEL = "Copied";
const MUTED = "text-xs text-muted-foreground";
const WRAP = "[overflow-wrap:anywhere]";

/** The browser's clock, ticking each second while `running`, unless a fixed one is given. */
function useNow(running: boolean, fixed: Date | undefined): Date {
	const [tick, setTick] = useState(() => new Date());
	useEffect(() => {
		if (!running || fixed) return;
		setTick(new Date());
		const timer = setInterval(() => setTick(new Date()), 1000);
		return () => clearInterval(timer);
	}, [running, fixed]);
	return fixed ?? tick;
}

/**
 * The Summary tab's content. What it shows is decided by `deriveSummaryView` (three independent
 * pieces: what is stored, what the person can do, how the last attempt ended); this renders them.
 * One primary action is on screen at a time, and a blocked action is its reason in the button's
 * place.
 */
export function SessionSummaryPanel(props: SessionSummaryPanelProps) {
	const { load, lostContact, aiStatus, viewer } = props;
	const headingId = useId();
	const root = useRef<HTMLElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const { announcement } = props;
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the announcement changes, nothing else
	useEffect(() => {
		const inside = root.current?.contains(document.activeElement) ?? false;
		if (shouldFocusHeading(announcement ?? null, inside)) heading.current?.focus();
	}, [announcement]);
	const generating = load.status === "ready" && load.view.attempt.status === "generating";
	const now = useNow(generating && !lostContact, props.clock?.now);
	const clock: ClockOptions = { ...props.clock, now };
	const model = deriveSummaryView(load, aiStatus, viewer, clock);
	const stored0 =
		model && (model.content.kind === "ready" || model.content.kind === "stale")
			? model.content.stored
			: null;
	const actions = useCopyActions({
		stored: stored0,
		meta: props.meta,
		generatedAt: load.status === "ready" ? load.view.generatedAt : null,
		staleEvents: load.status === "ready" ? load.view.staleEvents : 0,
		announce: props.announce,
	});
	const { copied, fallback } = actions;
	if (load.status === "unavailable") return null;
	const view = load.status === "ready" ? load.view : null;
	const stored =
		model && (model.content.kind === "ready" || model.content.kind === "stale")
			? model.content.stored
			: null;
	const stale = model?.content.kind === "stale";
	const copy = actions.copy;
	const body = model ? { ...props, model, view, clock } : null;
	return (
		<section
			ref={root}
			aria-labelledby={headingId}
			data-summary-state={model?.stateTag}
			className="max-w-4xl space-y-4 p-3 md:p-6"
		>
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<div className="flex items-center gap-2">
					<h2
						id={headingId}
						ref={heading}
						tabIndex={-1}
						className="text-base font-semibold focus:outline-none"
					>
						Summary
					</h2>
					<LabsBadge />
				</div>
				{body && stored && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<Freshness view={view} stored={stored} clock={clock} />
						{!stale && <ActionControl {...body} />}
						<CopyBar
							handoffLabel={body.model.copyLabels.handoff}
							summaryLabel={body.model.copyLabels.summary}
							copied={copied}
							onCopy={(kind) => void copy(kind)}
							fallback={fallback}
							onCloseFallback={actions.closeFallback}
						/>
					</div>
				)}
			</div>
			{body === null ? (
				<Skeleton />
			) : (
				<PanelBody {...body} copy={(kind) => void copy(kind)} copied={copied} />
			)}
		</section>
	);
}

type BodyProps = SessionSummaryPanelProps & {
	model: SummaryViewModel;
	view: SessionSummaryView | null;
	clock: ClockOptions;
};

function PanelBody(props: BodyProps & { copy: (kind: CopyKind) => void; copied: CopyKind | null }) {
	const { model } = props;
	switch (model.content.kind) {
		case "loading":
			return <Skeleton />;
		case "load_failed":
			return (
				<div className="flex flex-wrap items-center gap-3">
					<p className="text-sm text-foreground">Couldn't load the summary.</p>
					<button type="button" onClick={props.retry} className={OUTLINED}>
						Retry
					</button>
				</div>
			);
		case "none":
			return <EmptyBody {...props} />;
		case "ready":
		case "stale":
			return <StoredBody {...props} stored={model.content.stored} />;
	}
}

function Skeleton() {
	return (
		<div aria-busy="true" className="space-y-3">
			<div className="h-4 w-1/3 rounded bg-muted motion-safe:animate-pulse" />
			<div className="h-4 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
			<div className="h-4 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
		</div>
	);
}

// ── no summary yet ──────────────────────────────────────────────────────────

function EmptyBody(props: BodyProps) {
	const { model } = props;
	return (
		<div className="space-y-3">
			{model.action.kind !== "generating" && (
				<p className="text-sm text-muted-foreground">No summary yet.</p>
			)}
			<GeneratingStatus {...props} />
			<LostContact {...props} />
			<LastAttempt notice={model.notice} />
			<ActionControl {...props} />
		</div>
	);
}

// ── a stored summary ────────────────────────────────────────────────────────

function StoredBody(
	props: BodyProps & {
		stored: StoredSessionSummary;
		copy: (kind: CopyKind) => void;
		copied: CopyKind | null;
	},
) {
	const { model, stored, clock } = props;
	const stale = model.content.kind === "stale" ? model.content : null;
	const contextCopy = (
		<CopyButton
			label={props.copied === "context" ? COPIED_LABEL : model.copyLabels.context}
			onCopy={() => props.copy("context")}
		/>
	);
	return (
		<div className="space-y-4">
			<GeneratingStatus {...props} />
			<LostContact {...props} />
			{model.suspectNotice && <SuspectBlock notice={model.suspectNotice} />}
			{stale && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2">
					<p className="text-sm text-foreground">{stale.text}</p>
					<ActionControl {...props} />
				</div>
			)}
			<LastAttempt notice={model.notice} />
			<SummarySections
				contextAction={contextCopy}
				stored={stored}
				sessionId={props.sessionId}
				agentType={props.agentType}
				clock={clock}
			/>
			<Footer view={props.view} clock={clock} />
		</div>
	);
}

function CopyButton({ label, onCopy }: { label: string; onCopy: () => void }) {
	return (
		<button type="button" data-copy onClick={onCopy} className={QUIET}>
			{label}
		</button>
	);
}

function Freshness({
	view,
	stored,
	clock,
}: { view: SessionSummaryView | null; stored: StoredSessionSummary; clock: ClockOptions }) {
	const made = view?.generatedAt ? relativeAgo(view.generatedAt, clock) : "";
	const through = stored.provenance.throughAt
		? formatMoment(stored.provenance.throughAt, clock)
		: "";
	const partial = partialEvidenceNotice(stored.provenance.coverage, clock);
	const generated = [made && `Generated ${made}`, through && `through ${through}`]
		.filter(Boolean)
		.join(", ");
	if (!generated && !partial) return <span />;
	return (
		<p className={MUTED}>
			{generated}
			{generated && partial ? ". " : ""}
			{partial}
		</p>
	);
}

function Footer({ view, clock }: { view: SessionSummaryView | null; clock: ClockOptions }) {
	const footer = view ? footerText(view, clock) : null;
	if (!footer) return null;
	return (
		<footer className={cn("space-y-0.5 border-t border-border pt-3", MUTED, WRAP)}>
			<p>{footer.line}</p>
			{footer.masked && <p>{footer.masked}</p>}
			{footer.retention && <p>{footer.retention}</p>}
		</footer>
	);
}

// ── notices ─────────────────────────────────────────────────────────────────

/** "Check this before pasting it into an agent": a bordered amber notice for text that addresses an agent or runs code, neutral text for the milder reasons. */
function SuspectBlock({ notice }: { notice: SuspectNotice }) {
	const warning = notice.tone === "warning";
	return (
		<div
			data-tone={notice.tone}
			className={cn(
				"space-y-1 text-xs",
				warning
					? "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200"
					: "text-muted-foreground",
			)}
		>
			<p className={warning ? "font-medium" : undefined}>{notice.lead}</p>
			<ul className="list-disc space-y-0.5 pl-4">
				{notice.lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		</div>
	);
}

function LastAttempt({ notice }: { notice: SummaryViewModel["notice"] }) {
	if (notice.kind === "none") return null;
	const error = notice.tone === "error";
	return (
		<output
			className={cn(
				"block rounded-md border px-3 py-2 text-xs",
				error
					? "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-300"
					: "border-border text-muted-foreground",
			)}
		>
			<span className="font-medium">{notice.lead}</span> {notice.reason}
		</output>
	);
}

function LostContact(props: BodyProps) {
	if (!props.lostContact || props.model.action.kind === "generating") return null;
	return (
		<div className="flex flex-wrap items-center gap-3">
			<output className="text-xs text-red-800 dark:text-red-300">
				Lost contact with the server.
			</output>
			<button type="button" onClick={props.retry} className={OUTLINED}>
				Retry
			</button>
		</div>
	);
}

// ── the one action ──────────────────────────────────────────────────────────

function GeneratingStatus(props: BodyProps) {
	const { action } = props.model;
	if (action.kind !== "generating") return null;
	if (props.lostContact) {
		return (
			<div className="flex flex-wrap items-center gap-3">
				<output className="text-xs text-red-800 dark:text-red-300">
					Lost contact with the server. The summary may still be finishing.
				</output>
				<button type="button" onClick={props.retry} className={OUTLINED}>
					Retry
				</button>
			</div>
		);
	}
	const elapsed = formatElapsed(action.startedAt, props.clock.now ?? new Date());
	return (
		<p className="flex items-start gap-2 text-sm text-foreground">
			<span
				aria-hidden="true"
				className="mt-1 inline-block h-3 w-3 flex-shrink-0 rounded-full border-2 border-muted-foreground border-t-transparent motion-safe:animate-spin"
			/>
			<span>
				{action.statusText}
				{elapsed && (
					<span className="ml-2 tabular-nums text-muted-foreground">{elapsed} so far</span>
				)}
			</span>
		</p>
	);
}

/** The button where the action is possible, its reason where it isn't. Never both, never two. */
function ActionControl(props: BodyProps) {
	const { action } = props.model;
	switch (action.kind) {
		case "none":
			return null;
		case "blocked":
			return <BlockedText action={action} />;
		case "generating":
			return (
				<button type="button" aria-disabled="true" className={QUIET}>
					{action.label}
				</button>
			);
		case "available":
			return <AvailableAction {...props} action={action} />;
	}
}

function BlockedText({ action }: { action: Extract<ActionState, { kind: "blocked" }> }) {
	return (
		<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
			<span className={WRAP}>{action.text}</span>
			{action.link && (
				<Link
					to={action.link.href}
					className="inline-flex min-h-[44px] items-center text-xs text-primary underline underline-offset-2 hover:text-foreground md:min-h-0"
				>
					{action.link.label}
				</Link>
			)}
		</p>
	);
}

function AvailableAction(
	props: BodyProps & { action: Extract<ActionState, { kind: "available" }> },
) {
	const { action, refusal } = props;
	const counting0 = refusal?.countdownSeconds != null;
	const { confirming, click, confirm, cancel } = useGenerateClick({
		generate: props.generate,
		counting: counting0,
	});
	const printId = useId();
	const buttonId = useId();
	const counting = refusal?.countdownSeconds != null;
	const filled = action.variant !== "update";

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<button
					id={buttonId}
					type="button"
					aria-describedby={action.finePrint ? printId : undefined}
					aria-disabled={counting ? "true" : undefined}
					onClick={() => void click()}
					className={filled ? FILLED : QUIET}
				>
					{action.label}
				</button>
				<output className={cn("text-xs text-muted-foreground", WRAP)}>{refusal?.text}</output>
			</div>
			{action.finePrint &&
				(action.variant === "summarize" ? (
					<div id={printId} className={cn("max-w-prose space-y-1", MUTED, WRAP)}>
						{(action.finePrintLines ?? [action.finePrint]).map((line) => (
							<p key={line} data-fine-print-line>
								{line}
							</p>
						))}
					</div>
				) : (
					<span id={printId} className="sr-only">
						{action.finePrint}
					</span>
				))}
			{confirming && action.confirm && (
				<ConfirmDialog
					title={action.confirm.title}
					confirmLabel={action.confirm.confirmLabel}
					cancelLabel={action.confirm.cancelLabel}
					focusCancel
					fallbackFocusId={buttonId}
					onConfirm={confirm}
					onCancel={cancel}
				>
					<p>{action.confirm.body}</p>
				</ConfirmDialog>
			)}
		</div>
	);
}
