import { useEffect, useRef } from "react";
import { COPY_FALLBACK_LINE } from "../../lib/summary-copy.js";

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

/** Copy handoff (outlined) and Copy summary (quiet), with the by-hand fallback under them after a refusal. */
export function CopyBar({
	handoffLabel,
	summaryLabel,
	onCopy,
	fallback,
	onCloseFallback,
}: {
	handoffLabel: string;
	summaryLabel: string;
	onCopy: (kind: "handoff" | "summary") => void;
	/** The text to show for copying by hand; null when the last copy worked. */
	fallback: string | null;
	onCloseFallback: () => void;
}) {
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<button type="button" data-copy onClick={() => onCopy("handoff")} className={OUTLINED}>
					{handoffLabel}
				</button>
				<button type="button" data-copy onClick={() => onCopy("summary")} className={BUTTON}>
					{summaryLabel}
				</button>
			</div>
			{fallback !== null && <CopyFallback text={fallback} onClose={onCloseFallback} />}
		</div>
	);
}
