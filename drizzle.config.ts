throw new Error(
	"Direct invocation of drizzle.config.ts is not supported. " +
		"Use drizzle.config.sqlite.ts or drizzle.config.postgres.ts instead.\n" +
		"  bun drizzle-kit generate --config drizzle.config.sqlite.ts\n" +
		"  bun drizzle-kit generate --config drizzle.config.postgres.ts\n" +
		"  bun run db:generate   (runs both)",
);
