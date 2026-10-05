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
	NOTHING_RECORDED,
	NO_UNFINISHED_WORK,
	type OutcomeFamily,
	claimOnlyCopy,
	claimOnlyMode,
	evidenceAccessibleName,
	evidenceLabel,
	outcomeChip,
	outcomeNotes,
	validationResultText,
	validationTally,
} from "../../lib/session-summary-view.js";
import { cn } from "../../lib/utils.js";

/**
 * The ten sections of a stored summary. Every string that came from the model is placed as a
 * React text node: no markup, no markdown, no links but the evidence links built from the ids the
 * server verified.
 */

const WRAP = "[overflow-wrap:anywhere]";

interface SectionsProps {
	stored: StoredSessionSummary;
	sessionId: string;
	agentType: string | null;
	clock?: ClockOptions;
}

export function SummarySections({ stored, sessionId, agentType, clock }: SectionsProps) {
	const { summary, provenance } = stored;
	const evidence = (ids: string[]) => (
		<EvidenceLinks ids={ids} stored={stored} sessionId={sessionId} clock={clock} />
	);
	const claims = claimOnlyCopy(agentType);
	return (
		<div className="space-y-5">
			<PlainSection title="Overview">
				<p className={cn("text-sm text-foreground", WRAP)}>{summary.overview}</p>
			</PlainSection>
			<OutcomeSection stored={stored} />
			<ClaimSection
				title="Accomplishments"
				items={summary.accomplishments}
				claims={claims}
				open
				render={(item) => (
					<>
						<span>{item.text}</span>
						{evidence(item.evidence)}
					</>
				)}
			/>
			<ChangesSection stored={stored} evidence={evidence} claims={claims} />
			<Section title="Decisions & Assumptions" count={summary.decisions.length}>
				<ul className="space-y-2">
					{summary.decisions.map((d, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
						<li key={i} className={WRAP}>
							<span>{d.text}</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								<span>Why: </span>
								{d.why}
							</span>
							{evidence(d.evidence)}
						</li>
					))}
				</ul>
			</Section>
			<ValidationSection summary={summary} stored={stored} evidence={evidence} />
			<Section title="Problems & Risks" count={summary.problems.length} open>
				<ul className="space-y-2">
					{summary.problems.map((p, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
						<li key={i} className={WRAP}>
							<span>{p.text}</span>
							{evidence(p.evidence)}
						</li>
					))}
				</ul>
			</Section>
			<Section
				title="Unfinished Work"
				count={summary.unfinished.length}
				open
				emptyLine={NO_UNFINISHED_WORK}
			>
				<ul className="space-y-2">
					{summary.unfinished.map((u, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
						<li key={i} className={WRAP}>
							<span>{u.text}</span>
							{evidence(u.evidence)}
						</li>
					))}
				</ul>
			</Section>
			<Section title="Recommended Next Actions" count={summary.nextActions.length} open>
				<ol className="list-decimal space-y-2 pl-5">
					{summary.nextActions.map((n, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
						<li key={i} className={WRAP}>
							<span>{n.text}</span>
							{evidence(n.evidence)}
						</li>
					))}
				</ol>
			</Section>
			<KeyContextSection handoff={summary.handoff} open={provenance.suspect} />
		</div>
	);
}

// ── section shells ──────────────────────────────────────────────────────────

const HEADING = "text-sm font-semibold text-foreground";

function PlainSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h3 className={HEADING}>{title}</h3>
			{children}
		</section>
	);
}

/**
 * A collapsible section with its count (or tally) in the heading. An empty one is the heading and
 * one muted line, never missing, so a reader can tell "nothing" from "not shown".
 */
function Section({
	title,
	count,
	tally,
	open = false,
	emptyLine = NOTHING_RECORDED,
	children,
}: {
	title: string;
	count: number;
	tally?: string;
	open?: boolean;
	emptyLine?: string;
	children: ReactNode;
}) {
	if (count === 0) {
		return (
			<section className="space-y-1">
				<h3 className={HEADING}>{title}</h3>
				<p className="text-xs text-muted-foreground">{emptyLine}</p>
			</section>
		);
	}
	return (
		<details open={open} className="group">
			<summary className="cursor-pointer select-none rounded-sm py-1 marker:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
				<h3 className={cn(HEADING, "inline")}>
					{title}
					<span className="font-normal text-muted-foreground"> · {tally ?? count}</span>
				</h3>
			</summary>
			<div className="mt-1.5 space-y-2 text-sm text-foreground">{children}</div>
		</details>
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

function OutcomeSection({ stored }: { stored: StoredSessionSummary }) {
	const { outcome } = stored.summary;
	const chip = outcomeChip(outcome.status);
	return (
		<PlainSection title="Outcome">
			<p>
				<span
					data-outcome={outcome.status}
					className={cn(
						"inline-block rounded-md border border-l-4 px-2.5 py-0.5 text-xs font-medium",
						CHIP_FAMILY[chip.family],
						chip.dashed && "border-dashed",
					)}
				>
					{chip.label}
				</span>
			</p>
			<p className={cn("text-sm text-foreground", WRAP)}>{outcome.explanation}</p>
			{outcomeNotes(stored).map((note) => (
				<p key={note} className="text-xs text-muted-foreground">
					{note}
				</p>
			))}
		</PlainSection>
	);
}

// ── evidence and claims ─────────────────────────────────────────────────────

function EvidenceLinks({
	ids,
	stored,
	sessionId,
	clock,
}: {
	ids: string[];
	stored: StoredSessionSummary;
	sessionId: string;
	clock?: ClockOptions;
}) {
	const links = [...new Set(ids)].flatMap((id) => {
		const to = evidenceHref(sessionId, id);
		if (!to) return [];
		const fact = Object.hasOwn(stored.provenance.evidence, id)
			? stored.provenance.evidence[id]
			: undefined;
		return [{ id, to, fact }];
	});
	if (links.length === 0) return null;
	return (
		<span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
			{links.map(({ id, to, fact }) => (
				<Link
					key={id}
					to={to}
					aria-label={evidenceAccessibleName(fact, clock)}
					className="inline-flex min-h-[44px] items-center text-xs text-primary underline underline-offset-2 hover:text-foreground md:min-h-0"
				>
					{evidenceLabel(fact, clock)}
				</Link>
			))}
		</span>
	);
}

type Claims = ReturnType<typeof claimOnlyCopy>;

function ClaimSection<T extends { unverified: boolean }>({
	title,
	items,
	claims,
	open,
	render,
}: {
	title: string;
	items: T[];
	claims: Claims;
	open?: boolean;
	render: (item: T) => ReactNode;
}) {
	const mode = claimOnlyMode(items);
	return (
		<Section title={title} count={items.length} open={open}>
			<ClaimNote mode={mode} claims={claims} />
			<ul className="space-y-2">
				{items.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
					<li key={i} className={WRAP}>
						{render(item)}
						{mode === "per_item" && item.unverified && <ClaimLabel claims={claims} />}
					</li>
				))}
			</ul>
		</Section>
	);
}

function ClaimLabel({ claims }: { claims: Claims }) {
	return (
		<span className="ml-2 inline-block rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
			{claims.label}
		</span>
	);
}

/** One line per section, not one per item; a Codex session also says why its commands can't confirm a claim. */
function ClaimNote({ mode, claims }: { mode: "none" | "per_item" | "section"; claims: Claims }) {
	if (mode === "none") return null;
	return (
		<div className="space-y-0.5 text-xs text-muted-foreground">
			<p>{mode === "section" ? claims.sectionNote : claims.help}</p>
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

function ChangesSection({
	stored,
	evidence,
	claims,
}: {
	stored: StoredSessionSummary;
	evidence: (ids: string[]) => ReactNode;
	claims: Claims;
}) {
	const { changes } = stored.summary;
	const mode = claimOnlyMode(changes);
	return (
		<Section title="Changes" count={changes.length}>
			<ClaimNote mode={mode} claims={claims} />
			{SUMMARY_CHANGE_KINDS.map((kind) => {
				const group = changes.filter((c) => c.kind === kind);
				if (group.length === 0) return null;
				return (
					<div key={kind}>
						<h4 className="text-xs font-medium text-muted-foreground">{KIND_LABELS[kind]}</h4>
						<ul className="mt-1 space-y-2">
							{group.map((c, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
								<li key={i} className={WRAP}>
									<span className="font-mono text-xs">{c.text}</span>
									{evidence(c.evidence)}
									{mode === "per_item" && c.unverified && <ClaimLabel claims={claims} />}
								</li>
							))}
						</ul>
					</div>
				);
			})}
		</Section>
	);
}

const RESULT_TONE: Record<SessionSummary["validation"][number]["result"], string> = {
	passed: "text-emerald-800 dark:text-emerald-300",
	failed: "text-red-800 dark:text-red-300",
	not_run: "text-muted-foreground",
	unknown: "text-amber-800 dark:text-amber-300",
};

function ValidationSection({
	summary,
	stored,
	evidence,
}: {
	summary: SessionSummary;
	stored: StoredSessionSummary;
	evidence: (ids: string[]) => ReactNode;
}) {
	const { validation } = summary;
	return (
		<Section
			title="Validation"
			count={validation.length}
			tally={validationTally(validation)}
			open={validation.some((v) => v.result === "failed")}
		>
			<ul className="space-y-2">
				{validation.map((v, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a stored list, never reordered
					<li key={i} className={WRAP}>
						<span>{v.what}</span>{" "}
						<span className={cn("text-xs font-medium", RESULT_TONE[v.result])}>
							{validationResultText(v, i, stored.provenance)}
						</span>
						{v.detail && (
							<span className="mt-0.5 block text-xs text-muted-foreground">{v.detail}</span>
						)}
						{evidence(v.evidence)}
					</li>
				))}
			</ul>
		</Section>
	);
}

function KeyContextSection({ handoff, open }: { handoff: string; open: boolean }) {
	return (
		<details open={open}>
			<summary className="cursor-pointer select-none rounded-sm py-1 marker:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
				<h3 className={cn(HEADING, "inline")}>Key Context for the Next Agent</h3>
			</summary>
			<p className={cn("mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground", WRAP)}>
				{handoff}
			</p>
		</details>
	);
}
