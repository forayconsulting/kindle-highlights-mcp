/**
 * Amazon device registration, as the Kindle app for iPhone does it.
 *
 * One browser sign-in yields an authorization code; `register` trades it for a
 * refresh token that lasts until the device is deregistered or the account
 * password changes. `websiteCookies` then mints amazon.com cookies from that
 * token on demand, so no cookie is ever stored.
 *
 * Ported from moifort/kindle-api-ts (MIT). These are private endpoints: the
 * constants below are the one place to change if Amazon stops accepting them.
 */
import {
	AmazonError,
	type Cookie,
	type DeviceCredentials,
	type LoginSession,
} from "./types";

export const DEVICE = {
	type: "A3NWHXTQ4EBCZS",
	appName: "Kindle",
	appVersion: "7.21",
	softwareVersion: "1210000000",
	bundleId: "com.amazon.Lassen",
	name: "Kindle for iPhone",
} as const;

/** The US store. Other stores need their own domain, marketplace id and handle. */
export const STORE = {
	domain: "com",
	marketplaceId: "ATVPDKIKX0DER",
	assocHandle: "usflex",
} as const;

export const LANDING_URL = `https://www.amazon.${STORE.domain}/ap/maplanding`;

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

const base64nopad = (bytes: Uint8Array) => base64(bytes).replace(/=+$/, "");

const base64url = (bytes: Uint8Array) =>
	base64nopad(bytes).replace(/\+/g, "-").replace(/\//g, "_");

const hexOf = (text: string) =>
	Array.from(new TextEncoder().encode(text), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

const clientIdOf = (serial: string) => hexOf(`${serial}#${DEVICE.type}`);

/**
 * Start a sign-in.
 *
 * Returns the URL to open in a browser, the session `register` needs, and
 * cookies the Kindle app would carry on that page. A browser that cannot
 * plant them may still be let through; the spike script tests both.
 */
export async function login(): Promise<{
	loginUrl: string;
	session: LoginSession;
	cookies: Cookie[];
}> {
	const codeVerifier = base64url(randomBytes(32));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(codeVerifier),
	);
	const codeChallenge = base64url(new Uint8Array(digest));
	const serial = crypto.randomUUID().replace(/-/g, "").toUpperCase();

	const params = new URLSearchParams({
		"openid.oa2.response_type": "code",
		"openid.oa2.code_challenge_method": "S256",
		"openid.oa2.code_challenge": codeChallenge,
		"openid.return_to": LANDING_URL,
		"openid.assoc_handle": STORE.assocHandle,
		"openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
		accountStatusPolicy: "P1",
		"openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
		"openid.mode": "checkid_setup",
		"openid.ns.oa2": "http://www.amazon.com/ap/ext/oauth/2",
		"openid.oa2.client_id": `device:${clientIdOf(serial)}`,
		"openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
		marketPlaceId: STORE.marketplaceId,
		"openid.oa2.scope": "device_auth_access",
		forceMobileLayout: "true",
		"openid.ns": "http://specs.openid.net/auth/2.0",
		"openid.pape.max_auth_age": "0",
	});

	const mapMd = JSON.stringify({
		device_user_dictionary: [],
		device_registration_data: { software_version: DEVICE.softwareVersion },
		app_identifier: {
			app_version: DEVICE.appVersion,
			bundle_id: DEVICE.bundleId,
		},
	});

	return {
		loginUrl: `https://www.amazon.${STORE.domain}/ap/signin?${params}`,
		session: { codeVerifier, serial, createdAt: Date.now() },
		cookies: [
			{ name: "frc", value: base64nopad(randomBytes(313)) },
			{
				name: "map-md",
				value: base64nopad(new TextEncoder().encode(mapMd)),
			},
			{ name: "amzn-app-id", value: "MAPiOSLib/6.0/ToHideRetailLink" },
		],
	};
}

/**
 * The authorization code in what the user pasted: the landing URL Amazon
 * redirected to after sign-in, or the bare code.
 */
export function authorizationCodeFrom(pasted: string): string | null {
	const text = pasted.trim();
	if (!text) return null;
	const match = text.match(/openid\.oa2\.authorization_code=([^&\s#]+)/);
	if (match) return decodeURIComponent(match[1]);
	return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : null;
}

async function refusalOf(response: Response): Promise<string> {
	const status = `${response.status} ${response.statusText}`.trim();
	const text = await response.text().catch(() => "");
	if (!text) return status;
	try {
		const answer = JSON.parse(text) as {
			response?: { error?: { code?: string; message?: string } };
			error?: string;
			error_description?: string;
		};
		const device = answer.response?.error;
		if (device?.code) {
			return `${status}: ${[device.code, device.message].filter(Boolean).join(" - ")}`;
		}
		if (answer.error) {
			return `${status}: ${[answer.error, answer.error_description].filter(Boolean).join(" - ")}`;
		}
	} catch {}
	return `${status}: ${text.slice(0, 300)}`;
}

/** Register the device with the authorization code from the landing URL. */
export async function register(
	authorizationCode: string,
	session: LoginSession,
	deviceName = "Kindle highlights MCP",
): Promise<DeviceCredentials> {
	const body = {
		requested_token_type: ["bearer", "mac_dms", "website_cookies"],
		cookies: { website_cookies: [], domain: `.amazon.${STORE.domain}` },
		registration_data: {
			domain: "Device",
			app_version: DEVICE.appVersion,
			device_serial: session.serial,
			device_type: DEVICE.type,
			// Amazon refuses a name the account already has, hence the serial.
			device_name: `${deviceName} ${session.serial.slice(0, 4)}`,
			os_version: "18.0",
			software_version: DEVICE.softwareVersion,
			device_model: "iPhone",
			app_name: DEVICE.appName,
		},
		auth_data: {
			client_id: clientIdOf(session.serial),
			authorization_code: authorizationCode,
			code_verifier: session.codeVerifier,
			code_algorithm: "SHA-256",
			client_domain: "DeviceLegacy",
		},
		requested_extensions: ["device_info", "customer_info"],
	};

	const response = await fetch(
		`https://api.amazon.${STORE.domain}/auth/register`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	if (!response.ok) {
		throw new AmazonError(
			"registration",
			`Device registration failed: ${await refusalOf(response)}`,
			response.status,
		);
	}

	const data = (await response.json()) as {
		response?: {
			success?: {
				tokens?: {
					bearer?: { refresh_token?: string };
					mac_dms?: { adp_token?: string; device_private_key?: string };
				};
			};
		};
	};
	const tokens = data.response?.success?.tokens;
	const refreshToken = tokens?.bearer?.refresh_token;
	const adpToken = tokens?.mac_dms?.adp_token;
	const devicePrivateKey = tokens?.mac_dms?.device_private_key;
	if (!refreshToken || !adpToken || !devicePrivateKey) {
		throw new AmazonError(
			"registration",
			"Device registration answered without tokens",
		);
	}
	return {
		refreshToken,
		adpToken,
		devicePrivateKey,
		serial: session.serial,
		registeredAt: Date.now(),
	};
}

interface ExchangeAnswer {
	response?: {
		tokens?: {
			cookies?: Record<string, { Name?: string; Value?: string }[]>;
		};
	};
}

/** Amazon groups the cookies by domain and quotes some values. */
export function cookiesOf(answer: ExchangeAnswer): Cookie[] {
	const cookies: Cookie[] = [];
	for (const group of Object.values(answer.response?.tokens?.cookies ?? {})) {
		for (const { Name, Value } of group) {
			if (Name && Value !== undefined) {
				cookies.push({ name: Name, value: Value.replace(/"/g, "") });
			}
		}
	}
	return cookies;
}

/** Fresh amazon.com cookies, minted from the device's refresh token. */
export async function websiteCookies(
	credentials: DeviceCredentials,
): Promise<Cookie[]> {
	const response = await fetch(
		`https://www.amazon.${STORE.domain}/ap/exchangetoken/cookies`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"x-amzn-identity-auth-domain": `api.amazon.${STORE.domain}`,
			},
			body: new URLSearchParams({
				app_name: DEVICE.appName,
				app_version: DEVICE.appVersion,
				source_token: credentials.refreshToken,
				requested_token_type: "auth_cookies",
				source_token_type: "refresh_token",
				domain: `.amazon.${STORE.domain}`,
			}).toString(),
		},
	);
	if (!response.ok) {
		throw new AmazonError(
			"cookie-exchange",
			`Cookie exchange failed: ${await refusalOf(response)}. If the device was removed from the Amazon account or the password changed, sign in again at /auth/{API_SECRET}/start`,
			response.status,
		);
	}
	const cookies = cookiesOf((await response.json()) as ExchangeAnswer);
	if (cookies.length === 0) {
		throw new AmazonError(
			"cookie-exchange",
			"Cookie exchange answered without cookies",
		);
	}
	return cookies;
}
