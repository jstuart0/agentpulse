export const config = {
	port: Number(process.env.PORT || 3000),
	host: process.env.HOST || "0.0.0.0",
	databaseUrl: process.env.DATABASE_URL || "",
	publicUrl: process.env.PUBLIC_URL || "http://localhost:3000",
	logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
	initialApiKey: process.env.AGENTPULSE_INITIAL_API_KEY || "",
	disableAuth: process.env.DISABLE_AUTH === "true",
	isProduction: process.env.NODE_ENV === "production",

	get useSqlite(): boolean {
		return !this.databaseUrl || !this.databaseUrl.startsWith("postgres");
	},

	get sqlitePath(): string {
		return "./data/agentpulse.db";
	},
};
