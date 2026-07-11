/**
 * Fetch web page content and extract readable text.
 *
 * Strips HTML tags, scripts, styles, and common boilerplate to return
 * a plain-text representation of the page.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_LENGTH = 100_000;

/** Common user-agent to avoid being blocked. */
const USER_AGENT =
	"Mozilla/5.0 (compatible; PiXman/1.0; +https://github.com/earendil-works/pi)";

export interface FetchResult {
	/** HTTP status code */
	status: number;
	/** Final URL after redirects */
	url: string;
	/** Content-Type header value */
	contentType: string | null;
	/** Extracted plain text (truncated to {@link MAX_CONTENT_LENGTH}) */
	text: string;
	/** Whether the content was truncated */
	truncated: boolean;
}

/**
 * Fetch a URL and extract readable text from the response.
 */
export async function fetchContent(url: string, signal?: AbortSignal): Promise<FetchResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	let combinedSignal = controller.signal;
	if (signal) {
		combinedSignal = AbortSignal.any([signal, controller.signal]);
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const response = await fetch(url, {
			signal: combinedSignal,
			redirect: "follow",
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html, text/plain, application/json, */*",
			},
		});

		const contentType = response.headers.get("content-type") || null;

		let raw = "";
		if (contentType?.includes("text/html")) {
			const html = await response.text();
			raw = extractTextFromHtml(html);
		} else {
			raw = await response.text();
		}

		const truncated = raw.length > MAX_CONTENT_LENGTH;
		const text = truncated
			? `${raw.slice(0, MAX_CONTENT_LENGTH)}\n\n[... content truncated ...]`
			: raw;

		return {
			status: response.status,
			url: response.url,
			contentType,
			text: text.trim(),
			truncated,
		};
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Extract plain text from HTML.
 */
function extractTextFromHtml(html: string): string {
	// Remove scripts, styles, and HTML comments
	let text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	// Insert line breaks before block-level elements
	const blockTags = [
		"</?div",
		"</?p>",
		"</?h[1-6]",
		"</?li",
		"</?tr",
		"</?br",
		"</?hr",
		"</?section",
		"</?article",
		"</?header",
		"</?footer",
		"</?main",
		"</?nav",
		"</?table",
		"</?blockquote",
		"</?pre",
		"</?figure",
	];
	for (const tag of blockTags) {
		text = text.replace(new RegExp(tag, "gi"), "\n$&");
	}

	// Strip remaining HTML tags
	text = text.replace(/<[^>]+>/g, "");

	// Decode common HTML entities
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)));

	// Collapse whitespace
	text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");

	// Trim empty lines at boundaries
	text = text.replace(/^\n+/, "").replace(/\n+$/, "");

	return text;
}
