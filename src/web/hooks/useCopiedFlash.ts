import type { CopyKind } from "../lib/summary-copy.js";

export const COPIED_FLASH_MS = 2000;

export function useCopiedFlash(_ms = COPIED_FLASH_MS): [CopyKind | null, (kind: CopyKind) => void] {
	return [null, () => {}];
}
