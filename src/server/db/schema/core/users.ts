/**
 * users table — dual-dialect (Decision 21 / Decision 22).
 * Local accounts: username + argon2id password hash + optional role.
 *
 * Local accounts coexist with SSO-bridged rows (auth_source =
 * "forwardauth"). SSO rows use username = "sso:" + provider + ":" + subject,
 * password_hash = "!" (never verifiable), and are keyed for lookup by the
 * (provider, subject) unique index below.
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import {
	integer,
	sqliteTable,
	uniqueIndex as sqliteUniqueIndex,
	text,
} from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

const PROVIDER_SUBJECT_INDEX = "idx_users_provider_subject";

export const usersSqlite = sqliteTable(
	"users",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		username: text("username").notNull().unique(),
		passwordHash: text("password_hash").notNull(),
		role: text("role").notNull().default("user"),
		disabledAt: text("disabled_at"),
		lastLoginAt: text("last_login_at"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
		/** "local" | "forwardauth". */
		authSource: text("auth_source").notNull().default("local"),
		/** Forwardauth provider label (e.g. "authentik"). Null for local accounts. */
		provider: text("provider"),
		/** Stable SSO subject identifier. Null for local accounts. */
		subject: text("subject"),
		/** "uid" | "username" | null. Null for local accounts and for an SSO row
		 * first touched through a pre-upgrade cookie, before any header request
		 * fills it. Written once; never changed after it is non-null. */
		subjectSource: text("subject_source"),
		/** Display name from the username header. May be an email at some IdPs. */
		displayName: text("display_name"),
		mustChangePassword: integer("must_change_password", { mode: "boolean" })
			.notNull()
			.default(false),
	},
	(t) => ({
		providerSubject: sqliteUniqueIndex(PROVIDER_SUBJECT_INDEX).on(t.provider, t.subject),
	}),
);

export const usersPg = pgTable(
	"users",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		username: pgText("username").notNull().unique(),
		passwordHash: pgText("password_hash").notNull(),
		role: pgText("role").notNull().default("user"),
		disabledAt: pgText("disabled_at"),
		lastLoginAt: pgText("last_login_at"),
		createdAt: tsColumn("postgres", "created_at"),
		updatedAt: tsColumn("postgres", "updated_at"),
		authSource: pgText("auth_source").notNull().default("local"),
		provider: pgText("provider"),
		subject: pgText("subject"),
		subjectSource: pgText("subject_source"),
		displayName: pgText("display_name"),
		mustChangePassword: boolean("must_change_password").notNull().default(false),
	},
	(t) => ({
		providerSubject: pgUniqueIndex(PROVIDER_SUBJECT_INDEX).on(t.provider, t.subject),
	}),
);
