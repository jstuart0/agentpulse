import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Session, SupervisorRecord } from "../../../shared/types.js";
import { useOwnershipUi, useViewerIsAdmin } from "../../hooks/useOwnershipUi.js";
import { api } from "../../lib/api.js";
import { ownerLabel } from "../../lib/owner-label.js";
import { sessionBindAccess } from "../../lib/session-bind-access.js";
import { parseDate } from "../../lib/utils.js";
import { useUserStore } from "../../stores/user-store.js";
import { useUsersStore } from "../../stores/users-store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { type TakeoverAttempt, bindRefusalMessage } from "./session-takeover-view.js";
import {
	type BindHostOption,
	type HostsLoad,
	TAKEOVER_HOSTS_FAILED,
	type TakeoverCardView,
	type TakeoverDialogLines,
	bindableHosts,
	takeoverCardView,
	takeoverConfirmLabel,
	takeoverDialogLines,
	takeoverEligibility,
	takeoverProgress,
} from "./takeover-card-view.js";

/** The bottom slot's id: focus lands here when the control that opened the dialog is gone. */
export const TAKEOVER_SLOT_ID = "takeover-slot";

const SLOT_CLASS = "border-t border-border bg-card/80 px-3 py-3 outline-none md:px-6";
const BUTTON_CLASS =
	"min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 md:min-h-0";
/** Keeps a long name, path or sentence inside a phone's width. */
const WRAP = "[overflow-wrap:anywhere]";
const TICK_MS = 15_000;
const PROGRESS_TICK_MS = 1_000;

/** The card's markup from its view alone, so each state can be rendered and read. */
export function TakeoverCardBody({
	view,
	onOpen,
	onRetryHosts,
}: {
	view: TakeoverCardView;
	onOpen: () => void;
	onRetryHosts?: () => void;
}) {
	if (view.kind === "hidden") return null;
	const loading = view.kind === "eligible" && view.hostsState === "loading";
	return (
		<section
			id={TAKEOVER_SLOT_ID}
			tabIndex={-1}
			aria-busy={loading || undefined}
			className={SLOT_CLASS}
		>
			<div className="flex flex-col gap-2">
				{view.failure ? (
					<p role="alert" className={`text-xs text-red-700 dark:text-red-400 ${WRAP}`}>
						{view.failure}
					</p>
				) : null}
				<p className={`text-xs leading-relaxed text-muted-foreground ${WRAP}`}>{view.text}</p>
				{view.kind === "no_host" && view.setupLink ? (
					<Link
						to="/hosts"
						className="min-h-[44px] self-start py-2 text-sm font-medium text-primary underline underline-offset-2 md:min-h-0 md:py-0"
					>
						Set up a host
					</Link>
				) : null}
				{view.kind === "eligible" && view.hostsState === "ready" ? (
					<button
						type="button"
						onClick={onOpen}
						aria-haspopup="dialog"
						className={`self-start ${BUTTON_CLASS}`}
					>
						Take over…
					</button>
				) : null}
				{view.kind === "eligible" && view.hostsState === "error" ? (
					<div className="flex flex-wrap items-center gap-2">
						<p className="text-xs text-foreground">{TAKEOVER_HOSTS_FAILED}</p>
						<button
							type="button"
							onClick={onRetryHosts}
							className="min-h-[44px] rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-accent md:min-h-0 md:py-1.5"
						>
							Try again
						</button>
					</div>
				) : null}
			</div>
		</section>
	);
}

/** Where the card was while the host works: one polite line. */
export function TakeoverProgress({ text }: { text: string }) {
	return (
		<section id={TAKEOVER_SLOT_ID} tabIndex={-1} className={SLOT_CLASS}>
			<output className={`block text-xs leading-relaxed text-muted-foreground ${WRAP}`}>
				{text}
			</output>
		</section>
	);
}

/** What the dialog is described by: the lead, who it concerns, and what the session will run under. */
export function TakeoverDialogDescription({ lines }: { lines: TakeoverDialogLines }) {
	return (
		<>
			<p className={WRAP}>{lines.lead}</p>
			{lines.adminNote ? <p className={WRAP}>{lines.adminNote}</p> : null}
			<p className={WRAP}>{lines.whatHappens}</p>
		</>
	);
}

/** The dialog's form: which machine, and the facts to check it by. No machine is chosen for the person. */
export function TakeoverDialogFields({
	options,
	hostId,
	onHost,
	lines,
}: {
	options: readonly BindHostOption[];
	hostId: string;
	onHost: (id: string) => void;
	lines: TakeoverDialogLines;
}) {
	const selectId = useId();
	const noteId = useId();
	return (
		<>
			<div>
				<label htmlFor={selectId} className="block text-sm font-medium text-foreground">
					Machine it ran on
				</label>
				<select
					id={selectId}
					value={hostId}
					onChange={(e) => onHost(e.target.value)}
					aria-describedby={noteId}
					className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm text-foreground md:min-h-0"
				>
					<option value="">Choose a machine</option>
					{options.map((option) => (
						<option key={option.id} value={option.id} disabled={option.disabled}>
							{option.label}
						</option>
					))}
				</select>
				<p id={noteId} className={`mt-1 text-xs text-muted-foreground ${WRAP}`}>
					{lines.reportedHostNote}
				</p>
			</div>
			<p className="break-all font-mono text-xs text-foreground">{lines.directory}</p>
			{lines.teamNote ? (
				<p className={`text-xs text-muted-foreground ${WRAP}`}>{lines.teamNote}</p>
			) : null}
		</>
	);
}

function formatTime(iso: string): string {
	const ms = parseDate(iso);
	return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
}

function useNow(everyMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(timer);
	}, [everyMs]);
	return now;
}

type HostsState =
	| { state: "idle" | "loading" | "error" }
	| { state: "ready"; list: SupervisorRecord[] };

/**
 * The take-over card for an observed Codex session, in the slot where the prompt box would be, and the
 * dialog behind its button. What it shows is decided in session-takeover-view.ts; the server decides what
 * is allowed. A refusal from the server stays in the dialog with the machine still chosen; only the 202
 * closes it, and then the page's progress line takes over from the attempt derived from the actions.
 */
export function SessionTakeoverCard({
	session,
	sessionName,
	attempt,
	onChanged,
}: {
	session: Session;
	sessionName: string;
	attempt: TakeoverAttempt;
	onChanged: () => Promise<void>;
}) {
	const ui = useOwnershipUi();
	const isAdmin = useViewerIsAdmin();
	const viewerUserId = useUserStore((s) => s.userId);
	const directory = useUsersStore((s) => s.byId);
	const now = useNow(TICK_MS);
	const canBind = sessionBindAccess(ui, session, {
		userId: viewerUserId,
		effectiveRole: isAdmin ? "admin" : "member",
	});
	const eligible = takeoverEligibility(session, now).kind === "eligible";

	const [hostsState, setHostsState] = useState<HostsState>({ state: "idle" });
	const [hostsKey, setHostsKey] = useState(0);
	const wantHosts = canBind && eligible;
	useEffect(() => {
		if (!wantHosts) return;
		let cancelled = false;
		setHostsState((current) => (current.state === "ready" ? current : { state: "loading" }));
		api
			.getSupervisors({ background: true })
			.then((result) => {
				if (!cancelled) setHostsState({ state: "ready", list: result.supervisors });
			})
			.catch(() => {
				if (!cancelled) setHostsState((c) => (c.state === "ready" ? c : { state: "error" }));
			});
		return () => {
			cancelled = true;
		};
	}, [wantHosts, hostsKey]);

	const hosts: HostsLoad = useMemo(() => {
		if (hostsState.state !== "ready") {
			return { state: hostsState.state === "error" ? "error" : "loading" };
		}
		return {
			state: "ready",
			...bindableHosts(hostsState.list, {
				ui,
				viewerUserId,
				isAdmin,
				session,
				now,
			}),
		};
	}, [hostsState, ui, viewerUserId, isAdmin, session, now]);

	const [open, setOpen] = useState(false);
	const [hostId, setHostId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [submittedTo, setSubmittedTo] = useState<string | null>(null);
	useEffect(() => {
		if (attempt.state !== "none") setSubmittedTo(null);
	}, [attempt.state]);

	const options = hosts.state === "ready" ? hosts.options : [];
	const chosen = options.find((option) => option.id === hostId && !option.disabled) ?? null;
	const chosenRecord =
		hostsState.state === "ready" ? hostsState.list.find((h) => h.id === chosen?.id) : undefined;
	const sessionOwner = session.ownerUserId ?? null;
	const team = ui.showHostOwner;
	const assignee =
		team && sessionOwner === null ? (chosenRecord?.ownerUserId ?? viewerUserId) : null;
	const lines = takeoverDialogLines({
		sessionName,
		owner: sessionOwner !== null && sessionOwner !== viewerUserId ? sessionOwner : null,
		ownerName:
			sessionOwner !== null
				? ownerLabel(directory[sessionOwner], sessionOwner, { selfId: viewerUserId })
				: null,
		assigneeName:
			assignee !== null && assignee !== undefined
				? ownerLabel(directory[assignee], assignee, { selfId: viewerUserId, style: "you" }).replace(
						/^You$/,
						"you",
					)
				: null,
		reportedHost: session.reportedHost ?? null,
		hostName: chosen?.name ?? null,
		cwd: session.cwd ?? null,
		team,
		viewerIsAdmin: isAdmin,
	});

	async function confirm() {
		if (!chosen || busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.bindSession(session.sessionId, { targetSupervisorId: chosen.id });
		} catch (failure) {
			setError(bindRefusalMessage(failure, { host: chosen.name, kind: "takeover" }));
			setBusy(false);
			return;
		}
		setSubmittedTo(chosen.name);
		setOpen(false);
		setBusy(false);
		try {
			await onChanged();
		} catch (failure) {
			console.error("Failed to refresh the session after a take-over", failure);
		}
	}

	if (submittedTo !== null && attempt.state === "none") {
		return <TakeoverProgress text={`Asking ${submittedTo} to take over this session…`} />;
	}
	const view = takeoverCardView({
		session,
		attempt,
		canBind,
		team,
		viewerIsAdmin: isAdmin,
		hosts,
		now,
		formatTime,
	});
	return (
		<>
			<TakeoverCardBody
				view={view}
				onOpen={() => {
					setHostId("");
					setError(null);
					setHostsKey((key) => key + 1);
					setOpen(true);
				}}
				onRetryHosts={() => setHostsKey((key) => key + 1)}
			/>
			{open ? (
				<ConfirmDialog
					title={lines.title}
					confirmLabel={takeoverConfirmLabel(chosen?.name ?? null)}
					busyLabel="Taking over…"
					armAfterMs={700}
					focusCancel
					busy={busy}
					confirmDisabled={chosen === null}
					error={error}
					fallbackFocusId={TAKEOVER_SLOT_ID}
					onConfirm={() => void confirm()}
					onCancel={() => setOpen(false)}
					fields={
						<TakeoverDialogFields
							options={options}
							hostId={hostId}
							onHost={(id) => {
								setHostId(id);
								setError(null);
							}}
							lines={lines}
						/>
					}
				>
					<TakeoverDialogDescription lines={lines} />
				</ConfirmDialog>
			) : null}
		</>
	);
}

/**
 * The slot while a take-over works: the host's name and what to expect, ticking to the "can take a minute
 * and a half" line after 20 seconds. Takes focus on mount when nothing else has it, because the card whose
 * button opened the dialog is gone by now.
 */
export function SessionTakeoverProgress({
	session,
	attempt,
}: {
	session: Session;
	attempt: Extract<TakeoverAttempt, { state: "in_flight" }>;
}) {
	const now = useNow(PROGRESS_TICK_MS);
	useEffect(() => {
		const active = document.activeElement;
		if (active === null || active === document.body) {
			document.getElementById(TAKEOVER_SLOT_ID)?.focus({ preventScroll: true });
		}
	}, []);
	return (
		<TakeoverProgress
			text={takeoverProgress(
				attempt.kind,
				session.managedSession?.hostName ?? null,
				attempt.startedAt,
				now,
			)}
		/>
	);
}
