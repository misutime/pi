/**
 * WebFetch extension — fetch and extract content from URLs via fetch service.
 *
 * Tool registration only. Delegates to service layer for provider flexibility.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetch } from "./service/index.ts";
import { applyTruncation, raceWithAbort } from "./format.ts";

export default function webfetch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its content as clean markdown. " +
			"Handles JavaScript-rendered pages, PDFs, and more.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch" }),
			onlyMainContent: Type.Optional(
				Type.Boolean({
					description:
						"Extract only main content, removing nav/footer/ads (default: true)",
				}),
			),
			waitFor: Type.Optional(
				Type.Integer({
					description: "Milliseconds to wait for JavaScript-rendered content",
					minimum: 0,
				}),
			),
		}),
		execute: async (_toolCallId, params, signal) => {
			const result = await raceWithAbort(
				fetch({
					url: params.url as string,
					onlyMainContent: params.onlyMainContent as boolean | undefined,
					waitFor: params.waitFor as number | undefined,
				}),
				signal,
			);

			// Build header with metadata
			const parts = [
				result.title ? `Title: ${result.title}` : "",
				result.sourceURL ? `Source: ${result.sourceURL}` : "",
				result.statusCode != null ? `Status: ${result.statusCode}` : "",
				result.description ? `Description: ${result.description}` : "",
			].filter(Boolean);
			const header = parts.length > 0 ? `${parts.join(" | ")}\n\n` : "";

			const text = applyTruncation(header + result.markdown, "page");

			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}
