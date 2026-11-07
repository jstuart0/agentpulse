/**
 * Where keyboard focus goes when the thing that held it is gone (a Stop dialog closed because the person
 * moved to another session, or the session stopped being one Stop applies to). Left alone, focus falls to
 * <body> and a keyboard or screen-reader user starts again from the top of the page. The first of the
 * session header, the page heading and `main` that exists takes it; the DOM is passed in so the choice is
 * testable without one.
 */
interface FocusableLike {
	tabIndex: number;
	hasAttribute(name: string): boolean;
	setAttribute(name: string, value: string): void;
	focus(options?: { preventScroll?: boolean }): void;
}

interface DocumentLike {
	getElementById(id: string): FocusableLike | null;
	querySelector(selector: string): FocusableLike | null;
}

export const SESSION_HEADER_ID = "session-header";

/** Moves focus to the best landing place now; returns whether there was one. */
export function focusLandingNow(doc: DocumentLike): boolean {
	const target =
		doc.getElementById(SESSION_HEADER_ID) ??
		doc.querySelector("main h1, h1") ??
		doc.querySelector("main");
	if (!target) return false;
	if (target.tabIndex < 0 && !target.hasAttribute("tabindex"))
		target.setAttribute("tabindex", "-1");
	target.focus({ preventScroll: true });
	return true;
}

/** How many frames to wait for the session header to appear (about half a second) before settling for the heading or `main`. */
export const LANDING_MAX_FRAMES = 30;

/**
 * Focuses the session header as soon as it exists. A session that isn't cached shows a loading placeholder
 * first, so the header can be several frames away: each frame looks for it, and only when the frames run out
 * does focus settle for the heading or `main` (never <body>). `schedule` runs a callback on the next frame.
 * Returns a cancel function for a page that goes away first.
 */
export function focusLandingWhenReady(
	doc: DocumentLike,
	schedule: (callback: () => void) => unknown,
	maxFrames = LANDING_MAX_FRAMES,
): () => void {
	let cancelled = false;
	let frames = 0;
	const step = () => {
		if (cancelled) return;
		frames += 1;
		if (doc.getElementById(SESSION_HEADER_ID) !== null || frames >= maxFrames) {
			focusLandingNow(doc);
			return;
		}
		schedule(step);
	};
	schedule(step);
	return () => {
		cancelled = true;
	};
}

/** After the render that follows, and the load after that if the session had to be fetched. */
export function focusLandingAfterRender(): void {
	focusLandingWhenReady(document as unknown as DocumentLike, (callback) =>
		requestAnimationFrame(callback),
	);
}
