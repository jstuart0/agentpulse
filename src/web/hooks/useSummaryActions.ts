import { useRef, useState } from "react";
import type { StoredSessionSummary } from "../../shared/session-summary.js";
import {
	COPY_ANNOUNCEMENT,
	type CopyKind,
	buildCopyText,
	copyToClipboard,
} from "../lib/summary-copy.js";
import { useCopiedFlash } from "./useCopiedFlash.js";
import type { UseSessionSummary } from "./useSessionSummary.js";

export interface CopyMetaInput {
	name: string | null;
	branch: string | null;
	cwd: string | null;
}

/**
 * The copy buttons' behaviour: build the text for the pressed kind, put it on the clipboard, and
 * on success flash "Copied" and announce it (again on a repeat: the text alternates by a trailing
 * non-breaking space so the live region sees a change). A refusal shows the text to copy by hand.
 */
export function useCopyActions(input: {
	stored: StoredSessionSummary | null;
	meta?: CopyMetaInput;
	generatedAt?: string | null;
	staleEvents?: number;
	announce?: (text: string) => void;
}) {
	const [fallback, setFallback] = useState<string | null>(null);
	const [copied, flashCopied] = useCopiedFlash();
	const repeat = useRef(false);
	async function copy(kind: CopyKind): Promise<void> {
		if (!input.stored) return;
		const text = buildCopyText(kind, input.stored, {
			...(input.meta ?? { name: null, branch: null, cwd: null }),
			generatedAt: input.generatedAt,
			staleEvents: input.staleEvents,
		});
		if ((await copyToClipboard(text)) === "copied") {
			setFallback(null);
			flashCopied(kind);
			repeat.current = !repeat.current;
			input.announce?.(`${COPY_ANNOUNCEMENT[kind]}${repeat.current ? "" : " "}`);
		} else setFallback(text);
	}
	return { copy, copied, fallback, closeFallback: () => setFallback(null) };
}

/**
 * The Summarize / Update click. Nothing is sent during a rate-limit countdown; a "needs
 * confirmation" answer opens the dialog, whose Replace sends the confirmed request and whose
 * Keep sends nothing.
 */
export function useGenerateClick(input: {
	generate: UseSessionSummary["generate"];
	counting: boolean;
}) {
	const [confirming, setConfirming] = useState(false);
	return {
		confirming,
		async click(): Promise<void> {
			if (input.counting) return;
			if ((await input.generate()) === "needs_confirmation") setConfirming(true);
		},
		confirm(): void {
			setConfirming(false);
			void input.generate({ confirmed: true });
		},
		cancel(): void {
			setConfirming(false);
		},
	};
}
