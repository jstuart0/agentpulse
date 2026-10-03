/**
 * How a person is named and abbreviated wherever an owner is shown. The
 * directory entry's name can be missing (an SSO user whose provider sent no
 * name) or, in a bad case, the stored "sso:..." handle; the fallback chain
 * guarantees a readable label either way.
 */
export interface DirectoryEntry {
	id: string;
	displayName: string | null;
	/** The login name, when the source knows it (the admin people list does; the directory doesn't). */
	username?: string | null;
	/** How the account signs in ("local" or an SSO provider), when the source knows it. */
	authSource?: string | null;
	disabled: boolean;
}

export interface OwnerLabelOptions {
	/** The signed-in user's id, to recognise "you". */
	selfId?: string | null;
	/** "you": the Owner select ("You"). "suffix": group headers ("Alice Smith (you)"). */
	style?: "plain" | "you" | "suffix";
}

const STORED_SSO_HANDLE = /^sso:/i;
const NAME_SEPARATORS = /[\s._-]+/;
const ID_FALLBACK_LENGTH = 4;
const ID_INITIALS_LENGTH = 2;

/** Control characters and the bidirectional overrides that can make one name read as another. */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Letters and signs that draw nothing (Hangul fillers, the blank Braille cell, Khmer inherent vowels, the Mongolian separator): a name of only these shows as an empty chip. */
const INVISIBLE_LETTERS = /[\u115F\u1160\u17B4\u17B5\u180E\u2800\u3164\uFFA0]/gu;

/** The text with everything that could mislead or draw nothing taken out, trimmed. */
function cleaned(text: string | null | undefined): string {
	return (text ?? "").replace(UNSAFE_CHARACTERS, "").replace(INVISIBLE_LETTERS, "").trim();
}

const LONGEST_KEY_LABEL = 64;
const UNNAMED_KEY = "Unnamed key";

/** The name worth showing: the display name, or an email's local part; null when there is none. */
function usableName(entry: DirectoryEntry | null | undefined): string | null {
	const raw = cleaned(entry?.displayName);
	if (!raw || STORED_SSO_HANDLE.test(raw)) return null;
	const at = raw.indexOf("@");
	return at > 0 && !/\s/.test(raw) ? raw.slice(0, at) : raw;
}

function nameOrFallback(entry: DirectoryEntry | null | undefined, id: string): string {
	return usableName(entry) ?? readableLogin(entry) ?? `User ${id.slice(0, ID_FALLBACK_LENGTH)}`;
}

/** Names that would read as the viewer or as the role itself when they belong to someone else. */
const IMPERSONATING_NAMES = new Set(["you", "admin"]);

function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A trailing "(you)" would read as the viewer's own mark in a list of people. */
const ENDS_IN_YOU = /\(\s*you\s*\)\s*$/i;

function isImpersonating(name: string): boolean {
	return IMPERSONATING_NAMES.has(name.trim().toLowerCase()) || ENDS_IN_YOU.test(name);
}

/** The sign-in name worth showing next to a display name: never the stored "sso:..." handle. */
function readableLogin(entry: DirectoryEntry | null | undefined): string | null {
	const login = cleaned(entry?.username);
	return login && !STORED_SSO_HANDLE.test(login) ? login : null;
}

/**
 * Whether a name needs a suffix to tell its owner apart from "You" or "Admin".
 * A name that is the account's own login doesn't: someone who signs in as
 * "admin" is the admin. A directory entry that doesn't say how the account
 * signs in and is called "admin" is read the same way (a local account's
 * display name is its login); "You" keeps the suffix, since nobody's own row
 * should ever be mistaken for the viewer's.
 */
function needsDisambiguation(entry: DirectoryEntry | null | undefined, shown: string): boolean {
	if (!isImpersonating(shown)) return false;
	const login = entry?.username?.trim();
	if (login && sameName(login, shown)) return false;
	if (entry?.authSource === "local") return false;
	const sourceUnknown = !login && (entry?.authSource === undefined || entry.authSource === null);
	return !(sourceUnknown && sameName(shown, "admin"));
}

export function ownerLabel(
	entry: DirectoryEntry | null | undefined,
	id: string,
	opts: OwnerLabelOptions = {},
): string {
	const isSelf = opts.selfId != null && opts.selfId === id;
	const shown = nameOrFallback(entry, id);
	const name =
		!isSelf && needsDisambiguation(entry, shown)
			? `${shown} (${readableLogin(entry) ?? id.slice(0, ID_FALLBACK_LENGTH)})`
			: shown;
	if (isSelf && opts.style === "you") return "You";
	if (isSelf && opts.style === "suffix") return `${name} (you)`;
	return entry?.disabled ? `${name} (disabled)` : name;
}

/** Two characters: the first letters of the first two words, else the first two characters. */
export function initialsFor(entry: DirectoryEntry | null | undefined, id: string): string {
	const name = usableName(entry);
	if (!name) return id.slice(0, ID_INITIALS_LENGTH).toUpperCase();
	const parts = name.split(NAME_SEPARATORS).filter(Boolean);
	if (parts.length >= 2) return `${[...parts[0]][0]}${[...parts[1]][0]}`.toUpperCase();
	return [...name].slice(0, 2).join("").toUpperCase();
}

function squashedName(entry: DirectoryEntry | null | undefined, id: string): string {
	const name = usableName(entry);
	return name ? name.replace(new RegExp(NAME_SEPARATORS, "g"), "") : id;
}

/** Initials never grow past this, however long the names that share them are. */
export const MAX_INITIALS_LENGTH = 8;

/** The name's first two letters in capitals, the rest as typed, cut to `length`. */
function prefixOf(name: string, length: number): string {
	const chars = [...name];
	return chars.slice(0, 2).join("").toUpperCase() + chars.slice(2, length).join("");
}

/**
 * Initials per person, where people who would share two characters get more:
 * `jsmith` and `jsmythe` become `JSmi` and `JSmy`, lengthening until they part
 * ways. Anyone whose initials are already unique keeps the two-character form.
 */
export function disambiguateInitials(
	people: ReadonlyArray<{ id: string; entry: DirectoryEntry | null | undefined }>,
): Map<string, string> {
	const result = new Map<string, string>();
	const groups = new Map<string, typeof people>();
	for (const person of people) {
		const initials = initialsFor(person.entry, person.id);
		groups.set(initials, [...(groups.get(initials) ?? []), person]);
	}

	for (const [initials, group] of groups) {
		if (group.length === 1) {
			result.set(group[0].id, initials);
			continue;
		}
		const names = group.map((person) => squashedName(person.entry, person.id));
		const longest = Math.max(...names.map((name) => [...name].length));
		let length = 3;
		while (
			length < Math.min(longest, MAX_INITIALS_LENGTH) &&
			new Set(names.map((name) => prefixOf(name, length))).size < names.length
		) {
			length += 1;
		}
		group.forEach((person, index) => {
			result.set(person.id, prefixOf(names[index], length));
		});
	}
	return result;
}

/** "alice-mbp (Alice's host)": whose machine a launch would run on. */
export function hostLabel(
	hostName: string,
	ownerId: string | null | undefined,
	lookup: (id: string) => DirectoryEntry | undefined,
	selfId?: string | null,
): string {
	if (!ownerId) return `${hostName} (unassigned host)`;
	if (selfId != null && selfId === ownerId) return `${hostName} (your host)`;
	const entry = lookup(ownerId);
	const suffix = entry?.disabled ? ", disabled" : "";
	return `${hostName} (${nameOrFallback(entry, ownerId)}'s host${suffix})`;
}

export function sessionOwnerText(
	session: { ownerUserId?: string | null; ownerKind?: "user" | "service" | "unassigned" },
	lookup: (id: string) => DirectoryEntry | undefined,
	selfId?: string | null,
): string {
	const owner = session.ownerUserId ?? null;
	if (owner !== null) return ownerLabel(lookup(owner), owner, { selfId, style: "you" });
	return session.ownerKind === "service" ? "Service key" : "Unassigned";
}

/**
 * A key's name as shown in dialog titles and toasts: cleaned like a person's
 * name (control, bidirectional and invisible characters out), cut to a sensible
 * length, and "Unnamed key" when nothing readable is left.
 */
export function keyLabel(name: string | null | undefined): string {
	const text = cleaned(name);
	if (!text) return UNNAMED_KEY;
	const chars = [...text];
	return chars.length > LONGEST_KEY_LABEL
		? `${chars.slice(0, LONGEST_KEY_LABEL - 1).join("")}…`
		: text;
}

/** The owner a search hit carries, as a name; null when the hit says nothing about one (an older server). */
export function hitOwnerText(
	hit: { ownerUserId?: string | null; ownerKind?: "user" | "service" | "unassigned" },
	lookup: (id: string) => DirectoryEntry | undefined,
	selfId?: string | null,
): string | null {
	if (hit.ownerUserId === undefined && hit.ownerKind === undefined) return null;
	return sessionOwnerText(hit, lookup, selfId);
}
