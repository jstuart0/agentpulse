import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./drizzle/schema.postgres.ts",
	out: "./drizzle/postgres",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://localhost/agentpulse_dev",
	},
});
