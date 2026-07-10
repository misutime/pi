/**
 * WebFetch extension — fetch web content from URLs.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchContent } from "./fetch.ts";

interface WebFetchDetails {
	success: boolean;
	url: string;
	error?: string;
	status?: number;
	contentType?: string | null;
	truncated?: boolean;
	length?: number;
}

export default function webfetch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description: `Fetches content from a URL and returns the extracted text.
Use this tool to read web pages, documentation, or API responses.
Accepts http:// and https:// URLs. HTML pages are stripped of tags
and returned as plain text. Returns up to 100,000 characters.`,
		parameters: Type.Object({
			url: Type.String({
				description: "The URL to fetch (must start with http:// or https://)",
			}),
		}),
		execute: async (_toolCallId, params, signal): Promise<AgentToolResult<WebFetchDetails>> => {
			const url = params.url as string;

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Invalid URL "${url}". Only http:// and https:// URLs are supported.`,
						},
					],
					details: { success: false, url, error: `Invalid URL: ${url}` },
				};
			}

			try {
				const result = await fetchContent(url, signal);

				const header = `Fetched ${url}\nStatus: ${result.status}\nContent-Type: ${result.contentType || "unknown"}${result.truncated ? ` (truncated to ${result.text.length} characters)` : ""}`;

				return {
					content: [{ type: "text", text: `${header}\n\n${result.text}` }],
					details: {
						success: true,
						url: result.url,
						status: result.status,
						contentType: result.contentType,
						truncated: result.truncated,
						length: result.text.length,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error fetching ${url}: ${message}` }],
					details: { success: false, url, error: message },
				};
			}
		},
	});
}
