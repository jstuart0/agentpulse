import { useEffect, useRef, useState } from "react";

/**
 * The text for a polite live region that should speak only when something changes while the page is open.
 * `key` names what is being shown (an update state, a notice kind); `text` is what to say for it, or null when
 * nothing is shown. Nothing is said for the first thing seen (`key` null, then a value: a page that loads
 * already showing it). A change of `key` while `text` is set says `text`; `text` going null clears it, so the
 * same words can be said again the next time.
 */
export function useAnnouncement(key: string | null, text: string | null): string {
	const previous = useRef<string | null>(null);
	const [said, setSaid] = useState("");
	useEffect(() => {
		if (text === null) setSaid("");
		else if (previous.current !== null && previous.current !== key) setSaid(text);
		previous.current = key;
	}, [key, text]);
	return said;
}
