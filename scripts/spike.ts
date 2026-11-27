/**
 * One-off check of the Amazon route from your own computer.
 *
 *   npm run spike                         sign in, then probe with plain fetch
 *   npm run spike -- --proxy http://localhost:8080
 *                                         also probe through the fetch proxy
 *                                         (docker build -t kindle-proxy container &&
 *                                          docker run --rm -p 8080:8080 kindle-proxy)
 *   npm run spike -- --browser            sign in through Playwright, which plants the
 *                                         Kindle app's cookies (use if the plain link is refused)
 *   npm run spike -- --fresh              ignore saved credentials and sign in again
 *
 * Credentials are saved to .spike-credentials.json (git-ignored). Each run
 * with --fresh registers a new device on the Amazon account; remove extras
 * under Manage Your Content and Devices.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
	authorizationCodeFrom,
	LANDING_URL,
	login,
	register,
} from "../src/amazon/device";
import { CLOUD_READER_DEVICE_TYPE } from "../src/amazon/reader";
import {
	DirectTransport,
	ProxyTransport,
	type Transport,
} from "../src/amazon/transport";
import type { DeviceCredentials } from "../src/amazon/types";
import { type ProbeStep, probe } from "../src/probe";

const FILE = new URL("../.spike-credentials.json", import.meta.url);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

async function signInWithBrowser(
	loginUrl: string,
	cookies: { name: string; value: string }[],
): Promise<string> {
	const moduleName = "playwright";
	const { chromium } = (await import(moduleName).catch(() => {
		throw new Error(
			"--browser needs Playwright: npm install --no-save playwright",
		);
	})) as typeof import("playwright");
	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext();
	await context.addCookies(
		cookies.map((c) => ({ ...c, domain: ".amazon.com", path: "/" })),
	);
	const page = await context.newPage();
	await page.goto(loginUrl);
	console.log("Sign in in the browser window (up to 5 minutes)...");
	await page.waitForURL((url) => url.href.startsWith(LANDING_URL), {
		timeout: 300_000,
	});
	const landed = page.url();
	await browser.close();
	return landed;
}

async function signIn(): Promise<DeviceCredentials> {
	const { loginUrl, session, cookies } = await login();
	let landed: string;
	if (flag("--browser")) {
		landed = await signInWithBrowser(loginUrl, cookies);
	} else {
		console.log("\n1. Open this address in your browser and sign in:\n");
		console.log(loginUrl);
		console.log(
			"\n2. Amazon then shows an error-looking page at amazon.com/ap/maplanding.",
		);
		console.log("   Copy that page's full address and paste it here.\n");
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		landed = await rl.question("Landing address: ");
		rl.close();
	}
	const code = authorizationCodeFrom(landed);
	if (!code)
		throw new Error("No openid.oa2.authorization_code in that address");
	const credentials = await register(code, session, "Kindle highlights spike");
	writeFileSync(FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
	console.log(
		"\nDevice registered; credentials saved to .spike-credentials.json",
	);
	return credentials;
}

function print(steps: ProbeStep[]) {
	for (const s of steps) {
		console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.step}\n      ${s.detail}`);
	}
}

async function main() {
	const credentials: DeviceCredentials =
		existsSync(FILE) && !flag("--fresh")
			? JSON.parse(readFileSync(FILE, "utf8"))
			: await signIn();

	const candidates = [
		...(option("--device-token") ? [option("--device-token") as string] : []),
		CLOUD_READER_DEVICE_TYPE,
	];

	const transports: Transport[] = [new DirectTransport()];
	const proxy = option("--proxy");
	if (proxy) {
		transports.push(
			new ProxyTransport((request) => fetch(request), proxy.replace(/\/$/, "")),
		);
	}

	const all: ProbeStep[] = [];
	for (const transport of transports) {
		console.log(`\n=== ${transport.name} ===`);
		const steps = await probe(credentials, transport, candidates);
		print(steps);
		all.push(...steps);
	}
	console.log(
		`\n${all.filter((s) => s.ok).length}/${all.length} steps passed. Send this output back to continue.`,
	);
}

main().catch((error) => {
	console.error(`\nFAIL  ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
