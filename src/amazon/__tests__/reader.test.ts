import { describe, expect, it } from "vitest";
import { CloudReader, largeCover, normalizeAuthors } from "../reader";
import {
	type HttpRequest,
	type HttpResponse,
	parseSetCookie,
	type Transport,
} from "../transport";
import { AmazonError } from "../types";

type Route = (request: HttpRequest) => Partial<HttpResponse> | undefined;

function fake(route: Route) {
	const requests: HttpRequest[] = [];
	const transport: Transport = {
		name: "fake",
		async send(request) {
			requests.push(request);
			const answer = route(request) ?? { status: 404, body: "no route" };
			return {
				status: 200,
				url: request.url,
				setCookies: [],
				body: "{}",
				...answer,
			};
		},
	};
	return { transport, requests };
}

const cookies = [
	{ name: "session-id", value: "111" },
	{ name: "at-main", value: "tok" },
];

describe("normalizeAuthors", () => {
	it("reorders Amazon's 'Last, First:' format", () => {
		expect(normalizeAuthors(["Azevedo, Rodrigo:"])).toEqual([
			"Rodrigo Azevedo",
		]);
		expect(normalizeAuthors(["King, Stephen:Straub, Peter"])).toEqual([
			"Stephen King",
			"Peter Straub",
		]);
		expect(normalizeAuthors(["Maddox"])).toEqual(["Maddox"]);
		expect(normalizeAuthors([])).toEqual([]);
	});
});

describe("largeCover", () => {
	it("strips the size marker", () => {
		expect(
			largeCover("https://m.media-amazon.com/images/I/51Q._SY400_.jpg"),
		).toBe("https://m.media-amazon.com/images/I/51Q.jpg");
	});
});

describe("parseSetCookie", () => {
	it("takes the name and value and ignores attributes", () => {
		expect(
			parseSetCookie("session-id=222; Domain=.amazon.com; Path=/"),
		).toEqual({
			name: "session-id",
			value: "222",
		});
		expect(parseSetCookie("garbage")).toBeNull();
	});
});

describe("CloudReader", () => {
	it("sends cookies, referer and session id", async () => {
		const { transport, requests } = fake(() => ({
			body: JSON.stringify({ itemsList: [] }),
		}));
		await new CloudReader(transport, cookies, "DEV").libraryPage();
		const headers = requests[0].headers ?? {};
		expect(headers.Cookie).toBe("session-id=111; at-main=tok");
		expect(headers.Referer).toBe("https://read.amazon.com/kindle-library");
		expect(headers["x-amzn-sessionid"]).toBe("111");
	});

	it("follows library pagination", async () => {
		const { transport, requests } = fake((request) =>
			request.url.includes("paginationToken=p2")
				? {
						body: JSON.stringify({ itemsList: [{ asin: "B2", title: "Two" }] }),
					}
				: {
						body: JSON.stringify({
							itemsList: [
								{ asin: "B1", title: "One", authors: ["Foer, Joshua:"] },
							],
							paginationToken: "p2",
						}),
					},
		);
		const books = await new CloudReader(transport, cookies, "DEV").library();
		expect(books.map((b) => b.asin)).toEqual(["B1", "B2"]);
		expect(books[0].authors).toEqual(["Joshua Foer"]);
		expect(requests).toHaveLength(2);
	});

	it("opens a device session once and sends its token to reader calls", async () => {
		const { transport, requests } = fake((request) => {
			if (request.url.includes("getDeviceToken")) {
				return { body: JSON.stringify({ deviceSessionToken: "ADP" }) };
			}
			if (request.url.includes("startReading")) {
				return {
					body: JSON.stringify({ YJFormatVersion: "G1", contentVersion: "R1" }),
				};
			}
			if (request.url.includes("getAnnotations")) {
				return {
					body: JSON.stringify({
						annotations: [
							{ type: "kindle.highlight", context: "Hi", start: 1, end: 3 },
						],
					}),
				};
			}
		});
		const reader = new CloudReader(transport, cookies, "DEV");
		const first = await reader.annotations("B1");
		await reader.annotations("B2");
		expect(first).toMatchObject({ guid: "G1", revision: "R1" });
		expect(first.items).toHaveLength(1);
		expect(
			requests.filter((r) => r.url.includes("getDeviceToken")),
		).toHaveLength(1);
		const annotationCall = requests.find((r) =>
			r.url.includes("getAnnotations"),
		);
		expect(annotationCall?.headers?.["x-adp-session-token"]).toBe("ADP");
		expect(annotationCall?.url).toContain("guid=G1");
	});

	it("retries getAnnotations with a doubled guid after a 500", async () => {
		const { transport, requests } = fake((request) => {
			if (request.url.includes("getDeviceToken")) {
				return { body: JSON.stringify({ deviceSessionToken: "ADP" }) };
			}
			if (request.url.includes("startReading")) {
				return { body: JSON.stringify({ formatVersion: "G1" }) };
			}
			if (request.url.includes("getAnnotations")) {
				return request.url.includes(encodeURIComponent("G1,G1"))
					? { body: JSON.stringify({ annotations: [] }) }
					: { status: 500, body: "boom" };
			}
		});
		const result = await new CloudReader(transport, cookies, "DEV").annotations(
			"B1",
		);
		expect(result.items).toEqual([]);
		expect(
			requests.filter((r) => r.url.includes("getAnnotations")),
		).toHaveLength(2);
	});

	it("reports a sign-in redirect as an expired session", async () => {
		const { transport } = fake(() => ({
			url: "https://www.amazon.com/ap/signin?x=1",
			body: "<html>",
		}));
		await expect(
			new CloudReader(transport, cookies, "DEV").libraryPage(),
		).rejects.toMatchObject({ kind: "auth-expired" });
	});

	it("reports 403 as blocked", async () => {
		const { transport } = fake(() => ({ status: 403, body: "denied" }));
		const error = await new CloudReader(transport, cookies, "DEV")
			.libraryPage()
			.catch((e) => e);
		expect(error).toBeInstanceOf(AmazonError);
		expect(error.kind).toBe("blocked");
	});

	it("adopts cookies the response sets", async () => {
		let call = 0;
		const { transport, requests } = fake(() => {
			call++;
			return {
				body: JSON.stringify({ itemsList: [] }),
				setCookies: call === 1 ? [{ name: "session-id", value: "999" }] : [],
			};
		});
		const reader = new CloudReader(transport, cookies, "DEV");
		await reader.libraryPage();
		await reader.libraryPage();
		expect(requests[1].headers?.["x-amzn-sessionid"]).toBe("999");
	});

	it("returns the full passage from copyText and rejects a refusal", async () => {
		const { transport, requests } = fake((request) => {
			if (request.url.includes("getDeviceToken")) {
				return { body: JSON.stringify({ deviceSessionToken: "ADP" }) };
			}
			if (request.url.includes("copyText")) {
				const sent = JSON.parse(request.body ?? "{}");
				return sent.startPosition === 1
					? { body: JSON.stringify({ status: "Ok", text: " Full passage. " }) }
					: { body: JSON.stringify({ status: "LimitExceeded" }) };
			}
		});
		const reader = new CloudReader(transport, cookies, "DEV");
		expect(await reader.copyText("B1", "G", "R", 1, 9)).toBe("Full passage.");
		expect(requests.at(-1)?.method).toBe("POST");
		await expect(reader.copyText("B1", "G", "R", 2, 9)).rejects.toThrow(
			"LimitExceeded",
		);
	});
});
