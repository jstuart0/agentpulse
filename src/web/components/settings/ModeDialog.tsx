import { useCallback, useEffect, useId, useRef, useState } from "react";
import { describeApiError } from "../../lib/api-errors.js";
import { DialogFooter, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../DialogParts.js";
import { DialogShell } from "../DialogShell.js";
import { ModeChangesScreen } from "./ModeChangesScreen.js";
import { ModeExistingScreen } from "./ModeExistingScreen.js";
import { type Loaded, loadEverything } from "./mode-dialog-data.js";

type Screen = "changes" | "existing";

type LoadState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| ({ status: "ready" } & Loaded);

interface ModeDialogProps {
	/** "existing" reopens the second screen later, from the checklist, without switching anything. */
	initialScreen: Screen;
	/** The id of the Team section's heading: where focus lands on close if the button that opened this is gone. */
	fallbackFocusId: string;
	onClose: () => void;
	/** Something the lists behind the dialog show has changed. */
	onChanged: () => void;
}

/**
 * Turning team mode on, in two screens. Screen 1 ("What changes") commits the
 * switch, and needs an answer for every ownerless key that can manage. Screen
 * 2 ("Existing items") is optional tidy-up: past sessions, then keys and
 * hosts one by one. Nothing here ever assigns keys or hosts in bulk.
 */
export function ModeDialog({
	initialScreen,
	fallbackFocusId,
	onClose,
	onChanged,
}: ModeDialogProps) {
	const headingId = useId();
	const [screen, setScreen] = useState<Screen>(initialScreen);
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [followsSwitch, setFollowsSwitch] = useState(false);
	const [busy, setBusy] = useState(false);
	const wasReady = useRef(false);

	const load = useCallback(async () => {
		setState({ status: "loading" });
		try {
			setState({ status: "ready", ...(await loadEverything()) });
		} catch (err) {
			setState({
				status: "error",
				message: describeApiError(err, "Couldn't load the people, keys and hosts."),
			});
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// A change of screen replaces the heading that had focus: put focus on the
	// new one, so the screen reader announces where it is.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the trigger is the screen and the load state
	useEffect(() => {
		if (state.status === "loading" && !wasReady.current) return;
		if (state.status === "ready") wasReady.current = true;
		const heading = document.getElementById(headingId);
		if (heading) {
			heading.setAttribute("tabindex", "-1");
			heading.focus({ preventScroll: true });
		}
	}, [screen, state.status]);

	const name = screen === "changes" ? "Turn on team mode: " : "Team mode: ";
	const title = screen === "changes" ? "What changes" : "Existing items";

	return (
		<DialogShell
			labelledBy={headingId}
			onClose={busy ? undefined : onClose}
			size="wide"
			fallbackFocusId={fallbackFocusId}
		>
			{state.status === "loading" && (
				<div className="p-5 md:p-6" aria-busy="true">
					<h2
						id={headingId}
						className="mb-3 text-base font-semibold text-foreground focus:outline-none"
					>
						<span className="sr-only">{name}</span>
						{title}
					</h2>
					<div className="space-y-2">
						{[1, 2, 3].map((n) => (
							<div key={n} className="h-10 animate-pulse rounded bg-muted" />
						))}
					</div>
					<div className="mt-4 flex justify-end">
						<button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
							Cancel
						</button>
					</div>
				</div>
			)}
			{state.status === "error" && (
				<>
					<div className="p-5 md:p-6">
						<h2
							id={headingId}
							className="mb-2 text-base font-semibold text-foreground focus:outline-none"
						>
							Couldn't open this
						</h2>
						<p role="alert" className="text-sm text-red-700 dark:text-red-400">
							{state.message}
						</p>
					</div>
					<DialogFooter>
						<button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
							Close
						</button>
						<button type="button" onClick={() => void load()} className={PRIMARY_BUTTON}>
							Try again
						</button>
					</DialogFooter>
				</>
			)}
			{state.status === "ready" && screen === "changes" && (
				<ModeChangesScreen
					headingId={headingId}
					headingPrefix={name}
					data={state}
					busy={busy}
					setBusy={setBusy}
					onCancel={onClose}
					onCommitted={async () => {
						setFollowsSwitch(true);
						onChanged();
						await load();
						setScreen("existing");
					}}
				/>
			)}
			{state.status === "ready" && screen === "existing" && (
				<ModeExistingScreen
					headingId={headingId}
					headingPrefix={name}
					data={state}
					followsSwitch={followsSwitch}
					busy={busy}
					setBusy={setBusy}
					onClose={onClose}
					onChanged={onChanged}
				/>
			)}
		</DialogShell>
	);
}
