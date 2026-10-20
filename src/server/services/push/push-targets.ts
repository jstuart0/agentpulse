/**
 * Who hears about an event: the one targeting policy.
 *
 * `PolicyPushTargets` is the only `PushTargetResolver`. Given an event it returns
 * the phones that should get it, and it is built on the same two predicates as
 * every other per-viewer channel (`sessionAudience` and `canReadSession`), so a
 * push can never reach someone the mobile WebSocket would not show the session.
 *
 * The rule, in a table:
 *
 *   event                          solo          team
 *   session-scoped events          all devices   the session owner's devices;
 *   (permission, turn, failed,                   an unowned session: admins'
 *   completed, hitl, alert rule,
 *   stuck, risky)
 *   action_request_opened          all devices   admins' devices
 *   launch_status                  all devices   the requester's devices;
 *                                                none recorded: admins'
 *   ask_reply                      the requester's devices, in both modes: the person's, else
 *                                 the devices paired with the key that asked; no requester: nobody.
 *                                 Then only the devices whose key can open the thread (ownsThread:
 *                                 the same own-thread rule a respond key is read under), so a tap
 *                                 never lands on "wasn't found". A thread the requester only
 *                                 continued (an admin or a solo caller on someone else's thread)
 *                                 reaches nobody; a thread that can't be found, nobody.
 *   daily_digest                   each device   nobody here (the digest job picks per owner)
 *   device_test                    nobody here (the route targets one chosen device)
 *
 * Eligibility comes first and applies to every send, alerts and Live Activity
 * updates alike (the source applies it): the device is live, its linked key is
 * active, and the key's owner exists and isn't disabled. Team mode fails closed:
 * a session or launch that can't be found, or a device whose key has no owner,
 * reaches nobody.
 */
import type { Actor } from "../../auth/actor.js";
import { type ThreadOwner, type ThreadReader, ownsThread } from "../ask/thread-ownership.js";
import { canReadSession, sessionAudience } from "../authorization.js";
import type { PushDevice, PushDispatchContext, PushEvent, PushTargetResolver } from "./types.js";

/** A device that may be sent to, with the role of the user behind it (null for an ownerless key). */
export interface EligibleDevice {
	device: PushDevice;
	role: "admin" | "member" | null;
}

/** Where the eligible devices come from. The device table implements this. */
export interface PushDeviceSource {
	listEligibleDevices(): Promise<EligibleDevice[]>;
}

/** The owner recorded on a session or a launch request; `ownerUserId` null means nobody owns it. */
export interface SubjectOwner {
	ownerUserId: string | null;
}

/** Looks up who owns the thing an event is about. Null means the thing doesn't exist. */
export interface PushSubjectReader {
	sessionOwner(sessionId: string): Promise<SubjectOwner | null>;
	launchRequester(launchId: string): Promise<SubjectOwner | null>;
	/** Who owns an Ask thread (user, else key). Null means the thread doesn't exist. */
	askThreadOwner(threadId: string): Promise<ThreadOwner | null>;
}

export type InstanceModeReader = () => Promise<"solo" | "team">;

const NO_SUBJECTS: PushSubjectReader = {
	sessionOwner: async () => null,
	launchRequester: async () => null,
	askThreadOwner: async () => null,
};

function adminDevices(eligible: EligibleDevice[]): PushDevice[] {
	return eligible.filter((e) => e.role === "admin").map((e) => e.device);
}

function devicesOf(eligible: EligibleDevice[], userIds: ReadonlySet<string>): EligibleDevice[] {
	return eligible.filter((e) => e.role !== null && userIds.has(e.device.userId));
}

export class PolicyPushTargets implements PushTargetResolver {
	constructor(
		private readonly source: PushDeviceSource,
		private readonly mode: InstanceModeReader,
		private readonly subjects: PushSubjectReader = NO_SUBJECTS,
		private readonly cache: { ms: number; now: () => number } = { ms: 0, now: Date.now },
	) {}

	private cached: { at: number; devices: EligibleDevice[] } | null = null;
	private epoch = 0;

	/**
	 * Forgets the cached device list. Called when a device, a key or a user's standing changed, so the
	 * next event judges eligibility afresh. A read that was already running when this was called is
	 * answered to its own caller but not remembered: it may predate the change.
	 */
	invalidate(): void {
		this.epoch += 1;
		this.cached = null;
	}

	/**
	 * The eligible devices, reused for `cache.ms` (about a second in production): a flood of events
	 * costs one join, not one per event. Revoking a device, revoking a key, disabling a user or changing
	 * a role calls `invalidate`; every Live Activity send also judges eligibility afresh.
	 */
	private async eligibleDevices(): Promise<EligibleDevice[]> {
		const now = this.cache.now();
		if (this.cached && now - this.cached.at < this.cache.ms) return this.cached.devices;
		const epoch = this.epoch;
		const devices = await this.source.listEligibleDevices();
		if (epoch === this.epoch) this.cached = { at: now, devices };
		return devices;
	}

	async resolve(event: PushEvent, ctx?: PushDispatchContext): Promise<PushDevice[]> {
		if (event.type === "device_test") return [];
		const eligible = (await this.eligibleDevices()).filter(
			(e) => e.device.sendTokenCiphertext !== "",
		);
		if (eligible.length === 0) return [];
		if (event.type === "ask_reply") return this.askReplyTargets(event, eligible);
		const mode = await this.mode();
		if (mode === "solo") return eligible.map((e) => e.device);
		// A digest is built for each device's owner (the sessions they may read), so in team mode there is no
		// one list to resolve here: the digest job picks its own targets, device by device. Never everyone.
		if (event.type === "daily_digest") return [];
		if (event.type === "action_request_opened") return adminDevices(eligible);
		if (event.type === "launch_status") return this.launchTargets(event.launchId, eligible);
		return this.sessionTargets(event.sessionId, eligible, ctx);
	}

	private async sessionTargets(
		sessionId: string,
		eligible: EligibleDevice[],
		ctx?: PushDispatchContext,
	): Promise<PushDevice[]> {
		const session = ctx
			? await ctx.session(sessionId)
			: await this.subjects.sessionOwner(sessionId);
		if (!session) return [];
		const audience = sessionAudience({ ownerUserId: session.ownerUserId }, "team");
		if (audience === "all") return adminDevices(eligible);
		return devicesOf(eligible, new Set(audience))
			.filter((e) => canReadSession(actorFor(e), { ownerUserId: session.ownerUserId }))
			.map((e) => e.device);
	}

	/**
	 * An Ask reply is private to whoever asked, whatever the mode: their devices, else the asking key's.
	 * A device is kept only if its key could open the thread as a respond key (which reads only what it
	 * owns). The device's key is read from the stored identity: a person's id for an owned key, `key:<id>`
	 * for an ownerless one. A manage-scope phone key could read more, but the push doesn't assume it.
	 */
	private async askReplyTargets(
		event: Extract<PushEvent, { type: "ask_reply" }>,
		eligible: EligibleDevice[],
	): Promise<PushDevice[]> {
		const { requesterUserId, requesterKeyId } = event;
		if (!requesterUserId && !requesterKeyId) return [];
		const devices = eligible
			.filter(({ device }) =>
				requesterUserId
					? device.ownerlessKeyId === null && device.userId === requesterUserId
					: device.ownerlessKeyId === requesterKeyId,
			)
			.map((e) => e.device);
		if (devices.length === 0) return [];
		const owner = await this.subjects.askThreadOwner(event.threadId);
		if (!owner) return [];
		return devices.filter((device) => ownsThread(owner, readerOf(device)));
	}

	private async launchTargets(launchId: string, eligible: EligibleDevice[]): Promise<PushDevice[]> {
		const launch = await this.subjects.launchRequester(launchId);
		if (!launch) return [];
		if (launch.ownerUserId === null) return adminDevices(eligible);
		return devicesOf(eligible, new Set([launch.ownerUserId])).map((e) => e.device);
	}
}

/**
 * May this device's owner read a session with this owner? The Live Activity
 * publisher asks it for every update: solo, always; team, `canReadSession` for
 * the device's user, so a handover or a lost role ends the activity.
 */
export function canDeviceReadSession(
	entry: EligibleDevice,
	sessionOwnerUserId: string | null,
	mode: "solo" | "team",
): boolean {
	if (mode === "solo") return true;
	return canReadSession(actorFor(entry), { ownerUserId: sessionOwnerUserId });
}

/** The credential behind a device, as a thread reader. */
function readerOf(device: PushDevice): ThreadReader {
	return device.ownerlessKeyId === null
		? { userId: device.userId, keyId: null }
		: { userId: null, keyId: device.ownerlessKeyId };
}

function actorFor(entry: EligibleDevice): Actor {
	return {
		userId: entry.device.userId,
		label: "api_key",
		role: entry.role ?? "none",
		mode: "team",
	};
}

/** A device source that holds devices in memory: for tests and for running the push modules without the device table. */
export class InMemoryDeviceSource implements PushDeviceSource {
	private readonly entries = new Map<string, EligibleDevice>();

	constructor(devices: PushDevice[] = [], roles: Record<string, EligibleDevice["role"]> = {}) {
		for (const device of devices) this.add(device, roles[device.id] ?? "member");
	}

	add(device: PushDevice, role: EligibleDevice["role"] = "member"): void {
		this.entries.set(device.id, { device, role });
	}

	remove(deviceId: string): void {
		this.entries.delete(deviceId);
	}

	async listEligibleDevices(): Promise<EligibleDevice[]> {
		return [...this.entries.values()];
	}
}
