/**
 * WebFetch extension — fetch and extract content from URLs via fetch service.
 *
 * Tool registration only. Delegates to service layer for multi-provider fallback.
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
			"Handles JavaScript-rendered pages via multi-provider fallback.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch" }),
		}),
		execute: async (_toolCallId, params, signal) => {
			const result = await raceWithAbort(
				fetch(
					{ url: params.url as string },
					signal,
				),
				signal,
			);

			// Build header with metadata
			const parts = [
				result.title ? `Title: ${result.title}` : "",
				result.sourceURL ? `Source: ${result.sourceURL}` : "",
				result.statusCode != null ? `Status: ${result.statusCode}` : "",
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
