import { defineConfig } from "drizzle-kit";

const sqlitePath = process.env.SQLITE_PATH ?? `${process.env.DATA_DIR ?? "./data"}/agentpulse.db`;

export default defineConfig({
	dialect: "sqlite",
	schema: "./drizzle/schema.sqlite.ts",
	out: "./drizzle/sqlite",
	dbCredentials: {
		url: sqlitePath,
	},
});
