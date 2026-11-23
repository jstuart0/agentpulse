/**
 * A leaf seam for "what kind of install is this": the update check asks it, and tests replace it so no test
 * probes the developer's real home. The test preload (db/test-env-defaults.ts) installs a fixed probe; nothing
 * in production sets one. Kept free of imports so the preload can load it before anything else.
 */
export type InstallProbe = () => {
	kind: "local" | "kubernetes" | "container" | "source";
	track: "release" | "ref" | null;
};

let override: InstallProbe | null = null;

/** Test only: replaces the install probe (null puts the real detection back). */
export function setInstallProbeForTests(probe: InstallProbe | null): void {
	override = probe;
}

/** The probe a test installed, or null in production. */
export function installProbeOverride(): InstallProbe | null {
	return override;
}
