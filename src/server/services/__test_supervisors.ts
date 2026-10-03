// Test helper: the whole suite shares one database, so a test file that
// registers supervisors must remove them, and a test file whose result depends
// on there being no supervisors must clear them in its own setup.
export async function deleteAllSupervisors(): Promise<void> {
	const { getDb } = await import("../db/client.js");
	const { supervisors } = await import("../db/schema/index.js");
	await getDb().delete(supervisors).execute();
}
