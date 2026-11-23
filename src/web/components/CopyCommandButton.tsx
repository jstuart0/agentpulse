import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopyFeedback } from "../hooks/useCopyFeedback.js";

/** The gap that lets a live region see "" then the message again, so a second click is announced too. */
const REANNOUNCE_GAP_MS = 60;

/**
 * Copies a command to the clipboard. The toast from `useCopyFeedback` is the visible answer; the sr-only
 * output says the same in place (and again on a second click), with the failure sentence when the clipboard
 * refuses. `label` is the accessible name and must differ per button when a page has several.
 */
export function CopyCommandButton({
	command,
	label,
	copiedText,
	failedText,
}: {
	command: string;
	label: string;
	copiedText: string;
	failedText: string;
}) {
	const { copyWithResult } = useCopyFeedback();
	const [copied, setCopied] = useState(false);
	const [said, setSaid] = useState("");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	async function onClick() {
		const ok = await copyWithResult(command, copiedText, failedText);
		setCopied(ok);
		setSaid("");
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setSaid(ok ? copiedText : failedText), REANNOUNCE_GAP_MS);
	}

	return (
		<>
			<button
				type="button"
				aria-label={label}
				onClick={() => void onClick()}
				className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				{copied ? (
					<Check aria-hidden="true" className="h-3.5 w-3.5" />
				) : (
					<Copy aria-hidden="true" className="h-3.5 w-3.5" />
				)}
				Copy
			</button>
			<output className="sr-only">{said}</output>
		</>
	);
}
