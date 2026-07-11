/**
 * WebSearch extension — web search via search service.
 *
 * Tool registration only. Delegates to service layer so we can swap
 * providers (Firecrawl → Exa → Gemini Search) without touching this file.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search } from "./service/index.ts";
import { applyTruncation, raceWithAbort } from "./format.ts";
import { MAX_SEARCH_LIMIT } from "./service/firecrawl.ts";

export default function websearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description:
			"Search the web and return titles, URLs, and descriptions. " +
			"Use webfetch to read a specific result in full.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query string" }),
			limit: Type.Optional(
				Type.Integer({
					description: `Max results (default: 10, max: ${MAX_SEARCH_LIMIT})`,
					minimum: 1,
					maximum: MAX_SEARCH_LIMIT,
				}),
			),
			includeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Only return results from these domains",
				}),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Exclude results from these domains",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> => {
			const includeDomains = normalizeDomains(params.includeDomains);
			const excludeDomains = normalizeDomains(params.excludeDomains);
			if (includeDomains && excludeDomains) {
				return {
					content: [
						{
							type: "text",
							text: "Error: includeDomains and excludeDomains cannot be used together.",
						},
					],
					details: { error: "Domain filter conflict" },
				};
			}

			const response = await raceWithAbort(
				search({
					query: params.query as string,
					limit: params.limit as number | undefined,
					includeDomains,
					excludeDomains,
				}),
				signal,
			);

			const { results, answer } = response;

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: answer || "No search results found." }],
					details: { resultCount: 0 },
				};
			}

			let text = "";

			// Gemini 返回的 LLM 答案（含行内引用）优先展示
			if (answer) {
				text += `${answer}

---

`;
			}

			text += `Found ${results.length} results:\n\n`;
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				const num = answer ? `[${i + 1}] ` : "";
				text += `${num}**${r.title}**\n`;
				text += `   ${r.url}\n`;
				if (r.description) text += `   ${r.description}\n`;
			}

			return {
				content: [
					{
						type: "text",
						text: applyTruncation(text, "search result content"),
					},
				],
				details: { resultCount: results.length },
			};
		},
	});
}

function normalizeDomains(
	domains: readonly string[] | undefined,
): string[] | undefined {
	if (!domains) return undefined;
	const normalized = domains.map((d) => d.trim()).filter(Boolean);
	const invalid = normalized.filter(
		(d) => d.includes("://") || d.includes("/") || d.includes("\\"),
	);
	if (invalid.length > 0) {
		throw new Error(
			`Search domains must be hostnames without protocol or path: ${invalid.join(", ")}`,
		);
	}
	return normalized.length > 0 ? normalized : undefined;
}
