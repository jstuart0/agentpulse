import { useEffect, useRef } from "react";

/**
 * Closes a dropdown when the user clicks outside it.
 * Returns a ref to attach to the dropdown's container element.
 *
 * Usage:
 *   const ref = useDropdownClose(() => setOpen(false));
 *   return <div ref={ref}>…</div>;
 */
export function useDropdownClose(onClose: () => void) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (!ref.current?.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [onClose]);
	return ref;
}
