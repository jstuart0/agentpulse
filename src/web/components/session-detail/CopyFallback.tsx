import { useEffect, useId, useRef } from "react";
import { COPY_FALLBACK_LINE, COPY_HANDOFF_HINT } from "../../lib/summary-copy.js";

/** The text, selected and ready to copy by hand, when the browser refused the clipboard. */
export function CopyFallback({ text, onClose }: { text: string; onClose: () => void }) {
	const box = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		box.current?.focus();
		box.current?.select();
	}, []);
	return (
		<div className="space-y-2 rounded-md border border-border p-3">
			<output className="block text-xs text-muted-foreground">{COPY_FALLBACK_LINE}</output>
			<textarea
				ref={box}
				readOnly
				value={text}
				rows={10}
				aria-label="Text to copy"
				className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs text-foreground"
			/>
			<button
				type="button"
				onClick={onClose}
				className="min-h-[44px] rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent md:min-h-0"
			>
				Close
			</button>
		</div>
	);
}

const BUTTON =
	"min-h-[44px] rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:min-h-0";
const OUTLINED =
	"min-h-[44px] rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent md:min-h-0";

/**
 * Copy handoff (outlined) and Copy full summary (quiet) for the heading row, then, under them on
 * a line of their own, the by-hand fallback after a refusal. The pressed button says "Copied" for
 * a moment (the clipboard changes nothing the eye can see). Copy handoff says what it holds, as
 * its description and as a visible hint from the desktop width up.
 */
export function CopyBar({
	handoffLabel,
	summaryLabel,
	copied = null,
	onCopy,
	fallback,
	onCloseFallback,
}: {
	handoffLabel: string;
	summaryLabel: string;
	/** The button just pressed shows "Copied" for a moment. */
	copied?: "handoff" | "summary" | "context" | null;
	onCopy: (kind: "handoff" | "summary") => void;
	/** The text to show for copying by hand; null when the last copy worked. */
	fallback: string | null;
	onCloseFallback: () => void;
}) {
	const hintId = useId();
	return (
		<>
			<button
				type="button"
				data-copy
				aria-describedby={hintId}
				onClick={() => onCopy("handoff")}
				className={OUTLINED}
			>
				{copied === "handoff" ? "Copied" : handoffLabel}
			</button>
			<button type="button" data-copy onClick={() => onCopy("summary")} className={BUTTON}>
				{copied === "summary" ? "Copied" : summaryLabel}
			</button>
			<span
				id={hintId}
				className="sr-only text-xs text-muted-foreground md:not-sr-only md:basis-full"
			>
				{COPY_HANDOFF_HINT}
			</span>
			{fallback !== null && (
				<div className="basis-full">
					<CopyFallback text={fallback} onClose={onCloseFallback} />
				</div>
			)}
		</>
	);
}
