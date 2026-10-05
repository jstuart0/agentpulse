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
