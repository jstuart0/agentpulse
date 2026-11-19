/**
 * A service manager for tests: tracks which units are "active", records every call, and runs hooks when a
 * unit starts or stops (the end-to-end test starts a fixture server child there and stops it by its handle).
 * Nothing here touches launchctl, systemctl or any real unit. Production code must not import it.
 */
import type { GoneQuery, ServiceManager, TimerSpec, UnitName } from "../service-manager.js";

export interface FakeServiceManager extends ServiceManager {
	calls: string[];
	active: Set<UnitName>;
	timerInstalled: TimerSpec | null;
	preflightResult: "ok" | "no_service_manager";
	/** Run when a unit is started or stopped; may throw to fail the call. */
	onStart?: (unit: UnitName) => Promise<void> | void;
	onStop?: (unit: UnitName) => Promise<void> | void;
	/** Overrides what `isGone` answers. */
	goneOverride?: (unit: UnitName, query: GoneQuery) => boolean | Promise<boolean>;
}

export function createFakeServiceManager(initiallyActive: UnitName[]): FakeServiceManager {
	const fake: FakeServiceManager = {
		kind: "fake",
		calls: [],
		active: new Set(initiallyActive),
		timerInstalled: null,
		preflightResult: "ok",
		async preflight() {
			fake.calls.push("preflight");
			return fake.preflightResult;
		},
		async activeUnits() {
			fake.calls.push("activeUnits");
			return [...fake.active];
		},
		async stop(unit) {
			fake.calls.push(`stop:${unit}`);
			await fake.onStop?.(unit);
			fake.active.delete(unit);
		},
		async start(unit) {
			fake.calls.push(`start:${unit}`);
			await fake.onStart?.(unit);
			fake.active.add(unit);
		},
		async isGone(unit, query) {
			fake.calls.push(`isGone:${unit}`);
			if (fake.goneOverride) return fake.goneOverride(unit, query);
			return !fake.active.has(unit);
		},
		async installTimer(spec) {
			fake.calls.push("installTimer");
			fake.timerInstalled = spec;
		},
		async removeTimer() {
			fake.calls.push("removeTimer");
			fake.timerInstalled = null;
		},
	};
	return fake;
}
