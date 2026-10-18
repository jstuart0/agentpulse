/**
 * Who hears about an event.
 *
 * `PushTargetResolver` (see types.ts) is the single policy point: given an event,
 * which registered phones get it. This file ships the solo-mode policy and an
 * in-memory device source; the team policy (session owner's devices, admins for
 * the unowned) and the device table come with the phases that own them.
 *
 * Solo mode means one person owns the instance, so every active phone is a
 * target. The resolver fails closed: it needs the instance mode handed to it and
 * returns nobody unless that mode is solo, so wiring it into a team instance by
 * mistake delivers nothing instead of delivering everyone's sessions to everyone.
 * A device with an empty stored send token is revoked and is no target.
 */
import type { PushDevice, PushEvent, PushTargetResolver } from "./types.js";

/** Where the active (registered, not revoked) devices come from. The device table implements this. */
export interface PushDeviceSource {
	listActiveDevices(): Promise<PushDevice[]>;
}

export type InstanceModeReader = () => Promise<"solo" | "team">;

export class SoloPushTargets implements PushTargetResolver {
	constructor(
		private readonly source: PushDeviceSource,
		private readonly mode: InstanceModeReader,
	) {}

	async resolve(_event: PushEvent): Promise<PushDevice[]> {
		if ((await this.mode()) !== "solo") return [];
		const devices = await this.source.listActiveDevices();
		return devices.filter((device) => device.sendTokenCiphertext !== "");
	}
}

/** A device source that holds devices in memory: for tests and for running the push modules without the device table. */
export class InMemoryDeviceSource implements PushDeviceSource {
	private readonly devices = new Map<string, PushDevice>();

	constructor(devices: PushDevice[] = []) {
		for (const device of devices) this.devices.set(device.id, device);
	}

	add(device: PushDevice): void {
		this.devices.set(device.id, device);
	}

	remove(deviceId: string): void {
		this.devices.delete(deviceId);
	}

	async listActiveDevices(): Promise<PushDevice[]> {
		return [...this.devices.values()];
	}
}
