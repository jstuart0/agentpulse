import { useMemo } from "react";
import type { DirectoryUser } from "../lib/api.js";
import { disambiguateInitials } from "../lib/owner-label.js";

/**
 * Initials for every person in the directory, made unique across them: the one
 * source for the owner chip on a card and on the session header, so a person
 * reads the same there as in Settings > People (which disambiguates over the
 * same people).
 */
export function useDirectoryInitials(
	directory: Record<string, DirectoryUser>,
): Map<string, string> {
	return useMemo(
		() => disambiguateInitials(Object.values(directory).map((entry) => ({ id: entry.id, entry }))),
		[directory],
	);
}
