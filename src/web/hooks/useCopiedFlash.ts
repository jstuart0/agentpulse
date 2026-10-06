import { useEffect, useRef, useState } from "react";
import type { CopyKind } from "../lib/summary-copy.js";

export const COPIED_FLASH_MS = 2000;

/** Which copy button was just pressed, for `ms`: it shows "Copied", then goes back. A new press restarts it. */
export function useCopiedFlash(ms = COPIED_FLASH_MS): [CopyKind | null, (kind: CopyKind) => void] {
	const [copied, setCopied] = useState<CopyKind | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	function flash(kind: CopyKind) {
		if (timer.current) clearTimeout(timer.current);
		setCopied(kind);
		timer.current = setTimeout(() => setCopied(null), ms);
	}
	return [copied, flash];
}
