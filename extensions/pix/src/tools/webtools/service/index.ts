/**
 * Service router — 多 provider 回退策略。
 *
 * - search: firecrawl + exa 随机排列，gemini 固定末尾（成本最高，最后回退）
 * - fetch: 仅 Firecrawl 支持
 * - 所有 provider 均失败时才抛错
 */

import { hasFirecrawlApiKey, hasExaApiKey, hasGeminiApiKey } from "../../../shared/config.ts";
import { search as firecrawlSearch, fetch as firecrawlFetch } from "./firecrawl.ts";
import { search as exaSearch } from "./exa.ts";
import { search as geminiSearch } from "./gemini.ts";
import type { SearchParams, SearchResponse, FetchParams, FetchResult } from "./firecrawl.ts";

type SearchProvider = "firecrawl" | "exa" | "gemini";

const SEARCH_IMPLS: Record<SearchProvider, (p: SearchParams) => Promise<SearchResponse>> = {
	firecrawl: firecrawlSearch,
	exa: exaSearch,
	gemini: geminiSearch,
};

function getSearchProviders(): SearchProvider[] {
	// firecrawl + exa 随机排列均衡负载，gemini 固定末尾（成本最高，最后回退）
	const primary: SearchProvider[] = [];
	if (hasFirecrawlApiKey()) primary.push("firecrawl");
	if (hasExaApiKey()) primary.push("exa");

	const result = shuffle(primary);

	if (hasGeminiApiKey()) result.push("gemini");

	if (result.length === 0) {
		throw new Error(
			"No search provider configured. " +
				"Set FIRECRAWL_API_KEY, EXA_API_KEY, or GEMINI_API_KEY, " +
				"or add firecrawl.apiKey / exa.apiKey / gemini.apiKey in pix-config.jsonc.",
		);
	}

	return result;
}

/** Fisher-Yates shuffle */
function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

export async function search(params: SearchParams): Promise<SearchResponse> {
	const providers = getSearchProviders();
	const errors: string[] = [];

	for (const provider of providers) {
		try {
			return await SEARCH_IMPLS[provider](params);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${provider}: ${msg}`);
		}
	}

	throw new Error(
		`All search providers failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
	);
}

export async function fetch(params: FetchParams): Promise<FetchResult> {
	return firecrawlFetch(params);
}
