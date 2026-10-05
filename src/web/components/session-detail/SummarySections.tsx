import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
	SUMMARY_CHANGE_KINDS,
	type SessionSummary,
	type StoredSessionSummary,
	type SummaryChangeKind,
} from "../../../shared/session-summary.js";
import { evidenceHref } from "../../lib/event-deep-link.js";
import {
	type ClockOptions,
	NO_VALIDATION_RECORDED,
	type OutcomeFamily,
	VALIDATION_FAILED_NOTE,
	claimOnlyCopy,
	evidenceLabel,
	linkNames,
	outcomeChip,
	outcomeNotes,
	validationResultText,
	validationTallyParts,
} from "../../lib/session-summary-view.js";
import { cn } from "../../lib/utils.js";
import { useSummaryViewStore } from "../../stores/summary-view-store.js";

/**
 * The ten sections of a stored summary. Every string that came from the model is placed as a
 * React text node: no markup, no markdown, no links but the evidence links built from the ids the
 * server verified. Sections start open; a section of more than `VISIBLE_ITEMS` items shows that
 * many and a "Show all" button. What the person opened, closed or expanded is held in
 * `summary-view-store` for the life of the page.
 */

const WRAP = "[overflow-wrap:anywhere]";
export const VISIBLE_ITEMS = 5;
export const VALIDATION_ANCHOR = "summary-validation";

interface SectionsProps {
	stored: StoredSessionSummary;
	sessionId: string;
	agentType: string | null;
	clock?: ClockOptions;
	/** The Copy context button, shown inside Key Context. */
	contextAction?: ReactNode;
}

type Claims = ReturnType<typeof claimOnlyCopy>;

interface Ctx {
	stored: StoredSessionSummary;
	sessionId: string;
	clock?: ClockOptions;
	claims: Claims;
	/** The first section with an "Agent's claim only" chip carries the one explanatory line. */
	claimHome: string | null;
}

export function SummarySections({
	stored,
	sessionId,
	agentType,
	clock,
	contextAction,
}: SectionsProps) {
	const { summary } = stored;
	const claims = claimOnlyCopy(agentType);
	const claimHome = summary.accomplishments.some((a) => a.unverified)
		? "accomplishments"
		: summary.changes.some((c) => c.unverified)
			? "changes"
			: null;
	const ctx: Ctx = { stored, sessionId, clock, claims, claimHome };
	const empty = [
		["Accomplishments", summary.accomplishments],
		["Changes", summary.changes],
		["Decisions & Assumptions", summary.decisions],
		["Problems & Risks", summary.problems],
		["Unfinished Work", summary.unfinished],
		["Recommended Next Actions", summary.nextActions],
	]
		.filter(([, items]) => (items as unknown[]).length === 0)
		.map(([title]) => title as string);
	return (
		<div className="space-y-5">
			<PlainSection title="Overview">
				<p className={cn("text-base text-foreground", WRAP)}>{summary.overview}</p>
			</PlainSection>
			<OutcomeSection stored={stored} />
			<Section k="accomplishments" title="Accomplishments" count={summary.accomplishments.length}>
				{ctx.claimHome === "accomplishments" && <ClaimLine claims={claims} />}
				<Items
					k="accomplishments"
					items={summary.accomplishments}
					lists={summary.accomplishments.map((a) => a.evidence)}
					ctx={ctx}
					render={(item, links) => (
						<>
							<span>{item.text}</span>
							{links}
							{item.unverified && <ClaimLabel claims={claims} />}
						</>
					)}
				/>
			</Section>
			<ChangesSection ctx={ctx} />
			<Section k="decisions" title="Decisions & Assumptions" count={summary.decisions.length}>
				<Items
					k="decisions"
					items={summary.decisions}
					lists={summary.decisions.map((d) => d.evidence)}
					ctx={ctx}
					render={(d, links) => (
						<>
							<span>{d.text}</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								<span>Why: </span>
								{d.why}
							</span>
							{links}
						</>
					)}
				/>
			</Section>
			<ValidationSection ctx={ctx} />
			<Section k="problems" title="Problems & Risks" count={summary.problems.length}>
				<Items
					k="problems"
					items={summary.problems}
					lists={summary.problems.map((p) => p.evidence)}
					ctx={ctx}
					render={(p, links) => (
						<>
							<span>{p.text}</span>
							{links}
						</>
					)}
				/>
			</Section>
			<Section k="unfinished" title="Unfinished Work" count={summary.unfinished.length}>
				<Items
					k="unfinished"
					items={summary.unfinished}
					lists={summary.unfinished.map((u) => u.evidence)}
					ctx={ctx}
					render={(u, links) => (
						<>
							<span>{u.text}</span>
							{links}
						</>
					)}
				/>
			</Section>
			<Section k="nextActions" title="Recommended Next Actions" count={summary.nextActions.length}>
				<Items
					k="nextActions"
					ordered
					items={summary.nextActions}
					lists={summary.nextActions.map((n) => n.evidence)}
					ctx={ctx}
					render={(n, links) => (
						<>
							<span>{n.text}</span>
							{links}
						</>
					)}
				/>
			</Section>
			<KeyContextSection handoff={summary.handoff} action={contextAction} />
			{empty.length > 0 && (
				<p className="text-xs text-muted-foreground">Nothing recorded for: {empty.join(", ")}.</p>
			)}
		</div>
	);
}

// ── section shells ──────────────────────────────────────────────────────────

const HEADING = "text-sm font-semibold text-foreground";
const SUMMARY_ROW =
	"cursor-pointer select-none rounded-sm py-1 marker:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

function PlainSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h3 className={HEADING}>{title}</h3>
			{children}
		</section>
	);
}

/**
 * A collapsible section with its count (or tally) in the heading. An empty one isn't drawn here:
 * the sections fold into one "Nothing recorded for" line (a Validation section says it itself).
 */
function Section({
	k,
	title,
	count,
	tally,
	id,
	children,
}: {
	k: string;
	title: string;
	count: number;
	tally?: ReactNode;
	id?: string;
	children: ReactNode;
}) {
	const closed = useSummaryViewStore((s) => s.closed[k] === true);
	const setOpen = useSummaryViewStore((s) => s.setOpen);
	if (count === 0) return null;
	return (
		<details
			id={id}
			open={!closed}
			onToggle={(e) => setOpen(k, e.currentTarget.open)}
			className="group scroll-mt-20"
		>
			<summary className={SUMMARY_ROW}>
				<h3 className={cn(HEADING, "inline")}>
					{title}
					<span className="font-normal text-muted-foreground"> · {tally ?? count}</span>
				</h3>
			</summary>
			<div className="mt-1.5 space-y-2 text-sm text-foreground">{children}</div>
		</details>
	);
}

/** A list of items, trimmed to the first few with a real button for the rest. */
function Items<T>({
	k,
	items,
	lists,
	ctx,
	render,
	ordered = false,
}: {
	k: string;
	items: T[];
	/** The ledger ids each item cites, for the evidence links. */
	lists: string[][];
	ctx: Ctx;
	render: (item: T, links: ReactNode) => ReactNode;
	ordered?: boolean;
}) {
	const expanded = useSummaryViewStore((s) => s.expanded[k] === true);
	const setExpanded = useSummaryViewStore((s) => s.setExpanded);
	const names = linkNames(lists, ctx.stored.provenance.evidence, ctx.clock);
	const shown = expanded ? items : items.slice(0, VISIBLE_ITEMS);
	const List = ordered ? "ol" : "ul";
	return (
		<>
			<List className={cn("space-y-2", ordered && "list-decimal pl-5")}>
				{shown.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
					<li key={i} className={WRAP}>
						{render(item, <EvidenceLinks ids={lists[i]} names={names[i]} ctx={ctx} />)}
					</li>
				))}
			</List>
			<ShowAll k={k} total={items.length} expanded={expanded} onToggle={setExpanded} />
		</>
	);
}

function ShowAll({
	k,
	total,
	expanded,
	onToggle,
}: {
	k: string;
	total: number;
	expanded: boolean;
	onToggle: (k: string, expanded: boolean) => void;
}) {
	if (total <= VISIBLE_ITEMS) return null;
	return (
		<button
			type="button"
			aria-expanded={expanded}
			onClick={() => onToggle(k, !expanded)}
			className="min-h-[44px] rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent md:min-h-0"
		>
			{expanded ? `Show first ${VISIBLE_ITEMS}` : `Show all ${total}`}
		</button>
	);
}

// ── outcome ─────────────────────────────────────────────────────────────────

const CHIP_FAMILY: Record<OutcomeFamily, string> = {
	green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
	blue: "border-blue-500/40 bg-blue-500/10 text-blue-800 dark:text-blue-300",
	amber: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
	red: "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-300",
	slate: "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

function jumpToValidation(event: { preventDefault: () => void }) {
	event.preventDefault();
	const target = document.getElementById(VALIDATION_ANCHOR);
	target?.scrollIntoView({ block: "start" });
	target?.querySelector("summary")?.focus();
}

/**
 * The answer: the chip, then what the server corrected or noted at body size (so a corrected
 * outcome never reads as a contradiction of the model's sentence under it), then the model's
 * sentence.
 */
function OutcomeSection({ stored }: { stored: StoredSessionSummary }) {
	const { outcome, validation } = stored.summary;
	const chip = outcomeChip(outcome.status);
	const notes = outcomeNotes(stored);
	const validationFailed =
		validation.some((v) => v.result === "failed") || notes.includes(VALIDATION_FAILED_NOTE);
	return (
		<PlainSection title="Outcome">
			<p>
				<span
					data-outcome={outcome.status}
					className={cn(
						"inline-block rounded-md border border-l-4 px-3 py-1 text-sm font-medium",
						CHIP_FAMILY[chip.family],
						chip.dashed && "border-dashed",
					)}
				>
					{chip.label}
				</span>
			</p>
			{notes
				.filter((note) => note !== VALIDATION_FAILED_NOTE)
				.map((note) => (
					<p key={note} className="text-sm text-foreground">
						{note}
					</p>
				))}
			{validationFailed && (
				<p className="text-sm text-red-800 dark:text-red-300">
					<a
						href={`#${VALIDATION_ANCHOR}`}
						onClick={jumpToValidation}
						className="underline underline-offset-2"
					>
						{VALIDATION_FAILED_NOTE}
					</a>
				</p>
			)}
			<p className={cn("text-sm text-foreground", WRAP)}>{outcome.explanation}</p>
		</PlainSection>
	);
}

// ── evidence and claims ─────────────────────────────────────────────────────

function EvidenceLinks({
	ids,
	names,
	ctx,
}: {
	ids: string[];
	names: string[];
	ctx: Ctx;
}) {
	const links = [...new Set(ids)].flatMap((id) => {
		const to = evidenceHref(ctx.sessionId, id);
		if (!to) return [];
		const fact = Object.hasOwn(ctx.stored.provenance.evidence, id)
			? ctx.stored.provenance.evidence[id]
			: undefined;
		return [{ id, to, fact }];
	});
	if (links.length === 0) return null;
	return (
		<span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
			{links.map(({ id, to, fact }, i) => (
				<Link
					key={id}
					to={to}
					aria-label={names[i]}
					className="inline-flex min-h-[44px] items-center text-xs text-primary underline underline-offset-2 hover:text-foreground md:min-h-0"
				>
					{evidenceLabel(fact, ctx.clock)}
				</Link>
			))}
		</span>
	);
}

/** Every unverified item has its own chip: visible text at the meta size, explained by one line per summary. */
function ClaimLabel({ claims }: { claims: Claims }) {
	return (
		<span className="ml-2 inline-block rounded border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
			{claims.label}
		</span>
	);
}

function ClaimLine({ claims }: { claims: Claims }) {
	return (
		<div className="space-y-0.5 text-xs text-muted-foreground">
			<p>{claims.summaryLine}</p>
			{claims.extra && <p>{claims.extra}</p>}
		</div>
	);
}

// ── changes, validation, key context ────────────────────────────────────────

const KIND_LABELS: Record<SummaryChangeKind, string> = {
	created: "Created",
	modified: "Modified",
	deleted: "Deleted",
	config: "Config",
	dependency: "Dependencies",
	schema: "Schema",
	infrastructure: "Infrastructure",
	git: "Git",
	other: "Other",
};

function ChangesSection({ ctx }: { ctx: Ctx }) {
	const { changes } = ctx.stored.summary;
	const expanded = useSummaryViewStore((s) => s.expanded.changes === true);
	const setExpanded = useSummaryViewStore((s) => s.setExpanded);
	const names = linkNames(
		changes.map((c) => c.evidence),
		ctx.stored.provenance.evidence,
		ctx.clock,
	);
	const ordered = SUMMARY_CHANGE_KINDS.flatMap((kind) =>
		changes.flatMap((c, i) => (c.kind === kind ? [{ c, i }] : [])),
	);
	const shown = expanded ? ordered : ordered.slice(0, VISIBLE_ITEMS);
	return (
		<Section k="changes" title="Changes" count={changes.length}>
			{ctx.claimHome === "changes" && <ClaimLine claims={ctx.claims} />}
			{SUMMARY_CHANGE_KINDS.map((kind) => {
				const group = shown.filter((x) => x.c.kind === kind);
				if (group.length === 0) return null;
				return (
					<div key={kind}>
						<h4 className="text-xs font-medium text-muted-foreground">{KIND_LABELS[kind]}</h4>
						<ul className="mt-1 space-y-2">
							{group.map(({ c, i }) => (
								<li key={i} className={WRAP}>
									<span className="font-mono text-xs">{c.text}</span>
									<EvidenceLinks ids={c.evidence} names={names[i]} ctx={ctx} />
									{c.unverified && <ClaimLabel claims={ctx.claims} />}
								</li>
							))}
						</ul>
					</div>
				);
			})}
			<ShowAll k="changes" total={changes.length} expanded={expanded} onToggle={setExpanded} />
		</Section>
	);
}

const RESULT_TONE: Record<SessionSummary["validation"][number]["result"], string> = {
	passed: "text-emerald-800 dark:text-emerald-300",
	failed: "text-red-800 dark:text-red-300",
	not_run: "text-muted-foreground",
	unknown: "text-amber-800 dark:text-amber-300",
};

function ValidationSection({ ctx }: { ctx: Ctx }) {
	const { validation } = ctx.stored.summary;
	if (validation.length === 0) {
		return (
			<section id={VALIDATION_ANCHOR} className="space-y-1">
				<h3 className={HEADING}>Validation</h3>
				<p className="text-xs text-muted-foreground">{NO_VALIDATION_RECORDED}</p>
			</section>
		);
	}
	const parts = validationTallyParts(validation);
	return (
		<Section
			k="validation"
			id={VALIDATION_ANCHOR}
			title="Validation"
			count={validation.length}
			tally={parts.map((part, i) => (
				<span key={part.result}>
					{i > 0 && " · "}
					<span className={RESULT_TONE[part.result]}>{part.text}</span>
				</span>
			))}
		>
			<Items
				k="validation"
				items={validation}
				lists={validation.map((v) => v.evidence)}
				ctx={ctx}
				render={(v, links) => {
					const index = validation.indexOf(v);
					return (
						<>
							<span>{v.what}</span>{" "}
							<span className={cn("text-xs font-medium", RESULT_TONE[v.result])}>
								{validationResultText(v, index, ctx.stored.provenance)}
							</span>
							{v.detail && !v.adjusted && (
								<span className="mt-0.5 block text-xs text-muted-foreground">{v.detail}</span>
							)}
							{links}
						</>
					);
				}}
			/>
		</Section>
	);
}

function KeyContextSection({ handoff, action }: { handoff: string; action?: ReactNode }) {
	const closed = useSummaryViewStore((s) => s.closed.handoff === true);
	const setOpen = useSummaryViewStore((s) => s.setOpen);
	return (
		<details open={!closed} onToggle={(e) => setOpen("handoff", e.currentTarget.open)}>
			<summary className={SUMMARY_ROW}>
				<h3 className={cn(HEADING, "inline")}>Key Context for the Next Agent</h3>
			</summary>
			<p className={cn("mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground", WRAP)}>
				{handoff}
			</p>
			{action && <div className="mt-1">{action}</div>}
		</details>
	);
}
