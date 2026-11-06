/**
 * The control_response bodies recorded Claude Code 2.1.318 accepted, as a validator. The fake `claude`
 * checks every line it is sent against this (and a parity test checks the recorded lines against it), so
 * a change to what the host writes that no recorded line shows fails a test rather than being forgiven by a
 * forgiving fake.
 */
const isRecord = (v: unknown): v is Record<string, any> =>
	!!v && typeof v === "object" && !Array.isArray(v);

/** True when `line` has a shape a recorded run accepted. */
export function isRecordedControlResponse(line: unknown): boolean {
	if (!isRecord(line) || line.type !== "control_response" || !isRecord(line.response)) return false;
	if (Object.keys(line).length !== 2) return false;
	const body = line.response;
	if (typeof body.request_id !== "string" || body.request_id === "") return false;
	if (body.subtype === "error") {
		return (
			typeof body.error === "string" &&
			Object.keys(body).sort().join() === "error,request_id,subtype"
		);
	}
	if (body.subtype !== "success") return false;
	const answer = body.response;
	if (Object.keys(body).sort().join() !== "request_id,response,subtype") return false;
	if (!isRecord(answer)) return false;
	if (answer.behavior === "allow") {
		return (
			Object.keys(answer).every((k) => k === "behavior" || k === "updatedInput") &&
			(!("updatedInput" in answer) || isRecord(answer.updatedInput))
		);
	}
	if (answer.behavior === "deny") {
		return (
			typeof answer.message === "string" &&
			Object.keys(answer).every((k) => ["behavior", "message", "interrupt"].includes(k)) &&
			(!("interrupt" in answer) || typeof answer.interrupt === "boolean")
		);
	}
	return false;
}
