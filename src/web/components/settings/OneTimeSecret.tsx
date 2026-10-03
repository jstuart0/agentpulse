import { useEffect, useRef } from "react";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import { useSecretLifetime } from "../../hooks/useSecretLifetime.js";
import { SECRET_LIFETIME_NOTE } from "../../lib/one-time-secret.js";

interface OneTimeSecretProps {
	title: string;
	/** What is shown, as labelled rows: the secret is the last row. */
	rows: Array<{ label: string; value: string; secret?: boolean }>;
	/** What the Copy button puts on the clipboard. */
	copyText: string;
	copyLabel: string;
	note: string;
	onDismiss: () => void;
}

/**
 * The "shown once" panel: the same shape as a freshly minted API key's. Focus
 * moves to its heading when it appears, so a keyboard user lands on the one
 * thing that can't be fetched again. It clears itself after five minutes and
 * when the tab is hidden.
 */
export function OneTimeSecret({
	title,
	rows,
	copyText,
	copyLabel,
	note,
	onDismiss,
}: OneTimeSecretProps) {
	const { copy } = useCopyFeedback();
	const headingRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		headingRef.current?.focus();
	}, []);
	useSecretLifetime(true, onDismiss);

	return (
		<section
			aria-label={title}
			className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4"
		>
			<p
				ref={headingRef}
				tabIndex={-1}
				className="mb-1 text-sm font-medium text-emerald-800 focus:outline-none dark:text-emerald-400"
			>
				{title}
			</p>
			<p className="mb-3 text-xs text-hint">
				{note} {SECRET_LIFETIME_NOTE}
			</p>
			<dl className="space-y-2">
				{rows.map((row) => (
					<div
						key={row.label}
						className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3"
					>
						<dt className="w-28 flex-shrink-0 text-xs text-hint">{row.label}</dt>
						<dd className="min-w-0 flex-1">
							<code
								className={`block break-all rounded border border-border bg-background px-3 py-2 text-sm text-foreground ${
									row.secret ? "select-all" : ""
								}`}
							>
								{row.value}
							</code>
						</dd>
					</div>
				))}
			</dl>
			<div className="mt-3 flex items-center gap-3">
				<button
					type="button"
					onClick={() => copy(copyText, copyLabel)}
					className="min-h-[44px] rounded-md bg-muted px-3 py-2 text-xs text-foreground transition-colors hover:bg-accent md:min-h-0"
				>
					Copy
				</button>
				<button
					type="button"
					onClick={onDismiss}
					className="min-h-[44px] px-2 text-xs text-hint transition-colors hover:text-foreground md:min-h-0"
				>
					Dismiss
				</button>
			</div>
		</section>
	);
}
