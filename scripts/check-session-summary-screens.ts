export interface ScreenEntry {
	file: string;
	screen: string;
	width: number;
	theme: string;
	kind: "viewport" | "full";
	state: string | null;
	finalPath: string;
	markerOk: boolean;
}

export const EXPECTED: Record<string, { path: string; state?: string }> = {};

export function validateManifest(
	_entries: ScreenEntry[],
	_names: string[],
	_read: (file: string) => Uint8Array | null,
): string[] {
	return [];
}
