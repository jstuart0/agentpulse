/**
 * Where the local server listens, for the health probe and the port-closed check. The effective values are the
 * ones the services run with: `PORT` and `HOST` in the checkout's `.env.local` (then `.env`), because the
 * installer writes them there and an operator may have edited them since; the install record is the fallback.
 * A record without a port gives no endpoint unless its server URL is itself a loopback address: a public
 * `serverUrl` over plain http is never probed. Values are read, never logged.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallRecord } from "../shared/install-record.js";

const MAX_ENV_BYTES = 64 * 1024;
const HOST_PATTERN = /^[A-Za-z0-9.:_[\]-]{1,255}$/;

export function parseEnvText(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		let value = line.slice(eq + 1).trim();
		if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
		out[line.slice(0, eq).trim()] = value;
	}
	return out;
}

function readEnvFile(path: string): Record<string, string> {
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.size > MAX_ENV_BYTES) return {};
		return parseEnvText(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

/** The address to probe for a bind host: wildcard and empty mean loopback. */
export function probeHost(host: string | null | undefined): string {
	const h = (host ?? "").trim();
	if (h === "" || h === "0.0.0.0") return "127.0.0.1";
	if (h === "::" || h === "[::]") return "[::1]";
	if (!HOST_PATTERN.test(h)) return "127.0.0.1";
	return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

export function isLoopbackProbeHost(host: string): boolean {
	return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

export interface LocalEndpoint {
	host: string;
	port: number | null;
}

function validPort(value: string | number | null | undefined): number | null {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export function localEndpoint(record: InstallRecord, app: string): LocalEndpoint {
	const env = { ...readEnvFile(join(app, ".env")), ...readEnvFile(join(app, ".env.local")) };
	let port = validPort(env.PORT) ?? record.port;
	if (port === null) {
		try {
			const url = new URL(record.serverUrl);
			if (record.serverTransport === "loopback")
				port = validPort(url.port || (url.protocol === "https:" ? 443 : 80));
		} catch {
			// no endpoint
		}
	}
	return { host: probeHost(env.HOST ?? record.host), port };
}
