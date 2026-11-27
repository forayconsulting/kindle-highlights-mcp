/** A sign-in in flight: what `register` needs to finish what `login` started. */
export interface LoginSession {
	codeVerifier: string;
	serial: string;
	createdAt: number;
}

/**
 * What a registered device keeps. The refresh token is a standing grant on
 * the Amazon account.
 */
export interface DeviceCredentials {
	refreshToken: string;
	adpToken: string;
	devicePrivateKey: string;
	serial: string;
	registeredAt: number;
}

export interface Cookie {
	name: string;
	value: string;
}

export interface Book {
	asin: string;
	title: string;
	authors: string[];
	coverUrl: string;
	resourceType: string;
	originType: string;
}

export interface Annotation {
	/** Stable within a book: kind plus position range. */
	id: string;
	kind: "highlight" | "note";
	text: string;
	note: string | null;
	color: string | null;
	location: number | null;
	start: number | null;
	end: number | null;
	/** True when `text` is Amazon's short preview of a longer passage. */
	truncated: boolean;
	modifiedAt: number | null;
}

export interface StartReading {
	guid: string;
	revision: string;
	isOwned: boolean;
	isSample: boolean;
}

export class AmazonError extends Error {
	constructor(
		readonly kind:
			| "registration"
			| "cookie-exchange"
			| "auth-expired"
			| "blocked"
			| "http"
			| "parse",
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "AmazonError";
	}
}
