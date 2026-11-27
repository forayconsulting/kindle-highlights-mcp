/** Amazon credentials and sync state, kept in KV. */
import { CLOUD_READER_DEVICE_TYPE } from "./amazon/reader";
import type { DeviceCredentials, LoginSession } from "./amazon/types";

const CREDENTIALS = "amazon:credentials";
const LOGIN_SESSION = "amazon:login_session";
const DEVICE_TOKEN = "amazon:device_token";
const SYNC_CURSOR = "sync:cursor";

export async function saveLoginSession(
	env: Env,
	session: LoginSession,
): Promise<void> {
	await env.KINDLE_KV.put(LOGIN_SESSION, JSON.stringify(session), {
		expirationTtl: 1800,
	});
}

export async function takeLoginSession(env: Env): Promise<LoginSession | null> {
	const stored = await env.KINDLE_KV.get(LOGIN_SESSION);
	return stored ? (JSON.parse(stored) as LoginSession) : null;
}

export async function saveCredentials(
	env: Env,
	credentials: DeviceCredentials,
): Promise<void> {
	await env.KINDLE_KV.put(CREDENTIALS, JSON.stringify(credentials));
	await env.KINDLE_KV.delete(LOGIN_SESSION);
}

export async function loadCredentials(env: Env): Promise<DeviceCredentials> {
	const stored = await env.KINDLE_KV.get(CREDENTIALS);
	if (!stored) {
		throw new Error(
			"No Amazon device registered. Sign in at /auth/{API_SECRET}/start",
		);
	}
	return JSON.parse(stored) as DeviceCredentials;
}

/**
 * The id the Cloud Reader session is opened with. Defaults to the Cloud
 * Reader's device type; override by storing a value captured from a browser's
 * getDeviceToken request if Amazon refuses the default.
 */
export async function deviceTokenFor(env: Env): Promise<string> {
	return (await env.KINDLE_KV.get(DEVICE_TOKEN)) ?? CLOUD_READER_DEVICE_TYPE;
}

export async function setDeviceToken(env: Env, token: string): Promise<void> {
	await env.KINDLE_KV.put(DEVICE_TOKEN, token);
}

export async function loadCursor(env: Env): Promise<number> {
	return Number((await env.KINDLE_KV.get(SYNC_CURSOR)) ?? "0") || 0;
}

export async function saveCursor(env: Env, cursor: number): Promise<void> {
	await env.KINDLE_KV.put(SYNC_CURSOR, String(cursor));
}
