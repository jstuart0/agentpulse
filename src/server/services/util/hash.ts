import { createHash } from "node:crypto";

/** Hex sha256 of a UTF-8 string. Server-only: `src/shared` ships to the web bundle. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}
