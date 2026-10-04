import { type DirectoryEntry, initialsFor, ownerLabel } from "./owner-label.js";
import { OWNER_ALL, type OwnedSession, type OwnerParam } from "./owner-scope.js";

/** What a session card's owner chip shows. */
export interface OwnerChipModel {
	kind: "user" | "service" | "unassigned";
	/** The text beside the circle (hidden on narrow screens). */
	text: string;
	/** Two or more letters for the circle; null for kinds without a person. */
	initials: string | null;
	/** What a screen reader says in place of the visual chip. */
	srText: string;
	/** The mouse tooltip, saying what "owner" means. */
	title: string;
}

export interface OwnerChipContext {
	viewerUserId: string | null;
	lookup: (userId: string) => DirectoryEntry | undefined;
	/** Initials made unique across the directory (disambiguateInitials). */
	initialsById: ReadonlyMap<string, string>;
}

const MEANING = "Any member can open and steer it.";

export function ownerChip(session: OwnedSession, ctx: OwnerChipContext): OwnerChipModel {
	const owner = session.ownerUserId ?? null;
	if (owner === null) {
		if (session.ownerKind === "service") {
			return {
				kind: "service",
				text: "Service key",
				initials: null,
				srText: "Owner: none, reported by a service key",
				title: `Reported by a service key, which has no owner. ${MEANING}`,
			};
		}
		return {
			kind: "unassigned",
			text: "Unassigned",
			initials: null,
			srText: "Owner: none",
			title: `Unassigned: no owner, and no key on record. ${MEANING}`,
		};
	}
	const entry = ctx.lookup(owner);
	const isSelf = ctx.viewerUserId !== null && owner === ctx.viewerUserId;
	const text = ownerLabel(entry, owner, { selfId: ctx.viewerUserId, style: "you" });
	return {
		kind: "user",
		text,
		initials: ctx.initialsById.get(owner) ?? initialsFor(entry, owner),
		srText: `Owner: ${text}`,
		title: `Owner: ${text}. Reported by ${isSelf ? "your" : "their"} key. ${MEANING}`,
	};
}

/** The chip says something only when the cards aren't already about one owner. */
export function ownerChipVisible(
	featureOn: boolean,
	owner: OwnerParam,
	groupBy: "project" | "user" | "agent" | "machine",
): boolean {
	return featureOn && owner === OWNER_ALL && groupBy !== "user";
}
