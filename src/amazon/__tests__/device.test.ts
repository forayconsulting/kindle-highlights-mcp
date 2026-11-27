import { describe, expect, it } from "vitest";
import { authorizationCodeFrom, cookiesOf, login } from "../device";

describe("login", () => {
	it("builds a PKCE sign-in URL for a fresh device", async () => {
		const { loginUrl, session, cookies } = await login();
		const url = new URL(loginUrl);
		expect(url.origin + url.pathname).toBe("https://www.amazon.com/ap/signin");
		expect(url.searchParams.get("openid.oa2.code_challenge_method")).toBe(
			"S256",
		);
		expect(url.searchParams.get("openid.return_to")).toBe(
			"https://www.amazon.com/ap/maplanding",
		);
		expect(session.serial).toMatch(/^[0-9A-F]{32}$/);

		// client id is hex("<serial>#<device type>")
		const clientId = url.searchParams
			.get("openid.oa2.client_id")
			?.replace("device:", "");
		const decoded = (clientId ?? "").replace(/../g, (h) =>
			String.fromCharCode(Number.parseInt(h, 16)),
		);
		expect(decoded).toBe(`${session.serial}#A3NWHXTQ4EBCZS`);
		expect(cookies.map((c) => c.name)).toEqual([
			"frc",
			"map-md",
			"amzn-app-id",
		]);
	});

	it("derives the challenge from the verifier", async () => {
		const { loginUrl, session } = await login();
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(session.codeVerifier),
		);
		const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(
			new URL(loginUrl).searchParams.get("openid.oa2.code_challenge"),
		).toBe(expected);
	});
});

describe("authorizationCodeFrom", () => {
	it("reads the code from a landing URL", () => {
		expect(
			authorizationCodeFrom(
				" https://www.amazon.com/ap/maplanding?openid.assoc_handle=usflex&openid.oa2.authorization_code=ANabc_123-XYZ&openid.mode=id_res ",
			),
		).toBe("ANabc_123-XYZ");
	});

	it("accepts a bare code", () => {
		expect(authorizationCodeFrom("ANabcdefghij")).toBe("ANabcdefghij");
	});

	it("rejects anything else", () => {
		expect(authorizationCodeFrom("")).toBeNull();
		expect(
			authorizationCodeFrom("https://www.amazon.com/ap/signin"),
		).toBeNull();
	});
});

describe("cookiesOf", () => {
	it("flattens domains and strips quotes", () => {
		expect(
			cookiesOf({
				response: {
					tokens: {
						cookies: {
							".amazon.com": [
								{ Name: "session-id", Value: "123-456" },
								{ Name: "x-main", Value: '"quoted"' },
								{ Name: "", Value: "ignored" },
							],
						},
					},
				},
			}),
		).toEqual([
			{ name: "session-id", value: "123-456" },
			{ name: "x-main", value: "quoted" },
		]);
	});

	it("returns nothing for an empty answer", () => {
		expect(cookiesOf({})).toEqual([]);
	});
});
