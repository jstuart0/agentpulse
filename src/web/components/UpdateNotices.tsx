import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAnnouncement } from "../hooks/useAnnouncement.js";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { UPDATE_NOTICE_COPY } from "../lib/update-notice-copy.js";
import { useUpdateStore } from "../stores/update-store.js";
import {
	type StaleTabView,
	type UpdateBannerView,
	deriveStaleTab,
	deriveUpdateBanner,
	dismissBanner,
	focusAfterBannerDismiss,
	isBannerDismissed,
	orderNotices,
} from "./update-view.js";

function sessionStore(): Storage | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

/**
 * What sits under the top of the page about updates: the stale-tab line (this tab is older than the
 * server) and, for the three red states only, a dismissible banner. The stale-tab line stacks first, since
 * a reload may clear the red state. Nothing here is `role="alert"`: a screen reader is told only when the
 * state turns red while the page is open, through the sr-only output.
 */
export function UpdateNotices({
	buildVersion = import.meta.env.VITE_APP_VERSION,
}: {
	buildVersion?: string;
}) {
	const status = useUpdateStore((s) => s.status);
	const { adminSettingsLocked } = useOwnershipUi();
	const banner = deriveUpdateBanner(status, { adminSettingsLocked });
	const staleTab = deriveStaleTab(status?.current, buildVersion);
	// A re-render after a dismissal: the answer itself lives in sessionStorage.
	const [, setDismissals] = useState(0);
	const dismissed = banner ? isBannerDismissed(sessionStore(), banner) : false;
	const shown = banner && !dismissed ? banner : null;

	const announcement = useAnnouncement(status?.state ?? null, shown ? shown.text : null);

	function dismiss() {
		if (!banner) return;
		dismissBanner(sessionStore(), banner);
		focusAfterBannerDismiss(document);
		setDismissals((n) => n + 1);
	}

	return (
		<UpdateNoticesView
			staleTab={staleTab}
			banner={shown}
			announcement={announcement}
			onDismiss={dismiss}
		/>
	);
}

export function UpdateNoticesView({
	staleTab,
	banner: shown,
	announcement,
	onDismiss: dismiss,
}: {
	staleTab: StaleTabView | null;
	banner: UpdateBannerView | null;
	announcement: string;
	onDismiss: () => void;
}) {
	const order = orderNotices({ staleTab, banner: shown });
	return (
		<>
			{/* Always present, outside the banner, so a screen reader hears a change in it. */}
			<output className="sr-only">{announcement}</output>
			{order.map((kind) =>
				kind === "stale_tab" && staleTab ? (
					<div
						key="stale"
						// biome-ignore lint/a11y/useSemanticElements: a polite status line that holds a button; role=status is what the plan and its test name
						role="status"
						className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted px-4 py-1 text-xs text-foreground md:px-6"
					>
						<span className="min-w-0 flex-1">{staleTab.text}</span>
						<button
							type="button"
							onClick={() => window.location.reload()}
							className="min-h-[44px] rounded-md border border-border bg-background px-3 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{staleTab.reloadLabel}
						</button>
					</div>
				) : shown ? (
					<section
						key="banner"
						aria-label={UPDATE_NOTICE_COPY.regionLabel}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-500/30 bg-red-500/10 px-4 py-1 text-xs text-red-800 dark:text-red-300 md:px-6"
					>
						<TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
						<p className="min-w-0 flex-1">{shown.text}</p>
						{shown.howTo && (
							<Link
								to="/settings?panel=updates"
								className="inline-flex min-h-[44px] items-center font-medium underline"
							>
								{UPDATE_NOTICE_COPY.howTo}
							</Link>
						)}
						{shown.notesUrl && (
							<a
								href={shown.notesUrl}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-h-[44px] items-center font-medium underline"
							>
								{UPDATE_NOTICE_COPY.notesLink}
							</a>
						)}
						<button
							type="button"
							aria-label={UPDATE_NOTICE_COPY.dismissLabel}
							onClick={dismiss}
							className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<X aria-hidden="true" className="h-4 w-4" />
						</button>
					</section>
				) : null,
			)}
		</>
	);
}
