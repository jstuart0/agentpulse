/**
 * Every `sessions` column except the two ownership ids (owner_user_id,
 * ingest_key_id). For a call site that needs "the whole row" for display or
 * classification — not one specific narrow projection — this is what to
 * select instead of a bare `.select()`: the two columns that must never
 * reach a prompt, a notification, or an Ask answer are structurally absent
 * from the result, not just conventionally avoided.
 */
import { getTableColumns } from "drizzle-orm";
import { sessions } from "./schema/index.js";

const { ownerUserId: _ownerUserId, ingestKeyId: _ingestKeyId, ...rest } = getTableColumns(sessions);

export const SESSION_COLUMNS_SANS_OWNERSHIP = rest;
