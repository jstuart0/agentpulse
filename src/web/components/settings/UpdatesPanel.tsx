import { useOwnershipUi } from "../../hooks/useOwnershipUi.js";
import { UPDATE_NOTICE_COPY, UPDATE_PANEL_COPY } from "../../lib/update-outcome-copy.js";
import { formatTimeAgo, parseDate } from "../../lib/utils.js";
import { panelAnchorId } from "../../pages/settings-panels.js";
import { type CheckNotice, useUpdateStore } from "../../stores/update-store.js";
import { useUserStore } from "../../stores/user-store.js";
import { CopyCommandButton } from "../CopyCommandButton.js";
import {
	type TimeFormat,
	type UpdatePanelView,
	checkNoticeText,
	derivePanelView,
} from "../update-panel-view.js";

/** The existing date helpers: "3h ago" in the text, the full local time in a tooltip. */
const TIME_FORMAT: TimeFormat = {
	ago: (iso) => formatTimeAgo(iso, { justNow: true }),
	full: (iso) => new Date(parseDate(iso)).toLocaleString(),
};

/**
 * Settings > Updates: what is running, what is the latest verified release, how to update, and a
 * "Check now" for an admin. Everything shown is a fixed template with a validated version, as React text.
 */
export function UpdatesPanel({
	hostname = typeof window === "undefined" ? "" : window.location.hostname,
}: {
	hostname?: string;
}) {
	const status = useUpdateStore((s) => s.status);
	const checking = useUpdateStore((s) => s.checking);
	const notice = useUpdateStore((s) => s.notice);
	const checkNow = useUpdateStore((s) => s.checkNow);
	const { adminSettingsLocked } = useOwnershipUi();
	const effectiveRole = useUserStore((s) => s.effectiveRole);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const view = derivePanelView(
		status,
		{ adminSettingsLocked, effectiveRole, disableAuth, hostname },
		TIME_FORMAT,
	);
	return (
		<UpdatesPanelView
			view={view}
			checking={checking}
			notice={notice}
			lastResult={status?.lastResult ?? null}
			onCheck={() => void checkNow()}
		/>
	);
}

export function UpdatesPanelView({
	view,
	checking,
	notice,
	lastResult = null,
	onCheck,
}: {
	view: UpdatePanelView;
	checking: boolean;
	notice: CheckNotice;
	lastResult?: string | null;
	onCheck: () => void;
}) {
	const commands = (view.command ?? []).filter((line) => line.command);
	const commandCount = commands.length;
	const commandNumber = (line: (typeof commands)[number]) => commands.indexOf(line) + 1;
	return (
		<section
			id={panelAnchorId("updates")}
			aria-labelledby="settings-updates-heading"
			className="border border-border bg-card rounded-lg p-5 mb-6"
		>
			<h2
				id="settings-updates-heading"
				tabIndex={-1}
				className="text-sm font-semibold mb-1 focus:outline-none"
			>
				{UPDATE_PANEL_COPY.title}
			</h2>
			<p className="text-sm text-foreground">{view.stateSentence}</p>
			{view.stateNext && <p className="text-xs text-muted-foreground">{view.stateNext}</p>}
			{view.staleLine && (
				<p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{view.staleLine}</p>
			)}

			{view.rows.length > 0 && (
				<dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
					{view.rows.map((row) => (
						<div key={row.label}>
							<dt className="text-xs text-muted-foreground">{row.label}</dt>
							<dd className="font-mono text-foreground" title={row.title}>
								{row.value}
							</dd>
						</div>
					))}
				</dl>
			)}

			{view.command && (
				<div className="mt-4 space-y-2 text-xs text-muted-foreground">
					{view.command.map((line, index) => (
						<div
							key={`${index}-${line.before}-${line.command ?? ""}`}
							className="flex flex-wrap items-center gap-2"
						>
							{line.before && <span>{line.before}</span>}
							{line.command && (
								<>
									<code className="break-all rounded bg-muted px-2 py-1 font-mono text-foreground">
										{line.command}
									</code>
									<CopyCommandButton
										command={line.command}
										label={
											commandCount > 1
												? UPDATE_PANEL_COPY.copyN(commandNumber(line), commandCount)
												: UPDATE_PANEL_COPY.copy
										}
										copiedText={UPDATE_PANEL_COPY.copied}
										failedText={UPDATE_PANEL_COPY.copyFailed}
									/>
								</>
							)}
							{line.after && <span>{line.after}</span>}
						</div>
					))}
				</div>
			)}
			{view.memberNotice && <p className="mt-4 text-xs text-hint">{view.memberNotice}</p>}

			{view.notesUrl && (
				<p className="mt-3 text-xs">
					<a
						href={view.notesUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex min-h-[44px] items-center font-medium underline md:min-h-0"
					>
						{UPDATE_NOTICE_COPY.notesLink}
					</a>
				</p>
			)}

			{view.checkNow === "button" && (
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<button
						type="button"
						disabled={checking}
						onClick={onCheck}
						className="min-h-[44px] rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
					>
						{checking ? UPDATE_PANEL_COPY.checking : UPDATE_PANEL_COPY.checkNow}
					</button>
					<output className="text-xs text-muted-foreground">
						{checkNoticeText(notice, lastResult)}
					</output>
				</div>
			)}
			{view.localhostLine && (
				<p className="mt-3 text-xs text-muted-foreground">{view.localhostLine}</p>
			)}
		</section>
	);
}
