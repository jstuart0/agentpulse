import { useEffect, useState } from "react";

/**
 * False for `ms` after it mounts, then true. For a confirmation whose button must not take a tap in the first
 * moments after the dialog opens (a double tap on the control that opened it, or a tap meant for what was
 * under the sheet). Zero or less is armed from the first render. A remount starts the wait again.
 */
export function useArmedAfter(ms: number): boolean {
	const [armed, setArmed] = useState(ms <= 0);
	useEffect(() => {
		if (ms <= 0) return;
		const timer = setTimeout(() => setArmed(true), ms);
		return () => clearTimeout(timer);
	}, [ms]);
	return armed;
}
