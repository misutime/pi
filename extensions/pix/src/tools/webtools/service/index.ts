/**
 * Service router — 根据已配置的 API key（env 或 pix-config.json）随机选择 provider。
 *
 * 目的：分散请求负载，避免单一 provider 限流。
 * 规则：fetch 仅 Firecrawl 支持；search 在已配置的 provider 中随机挑选。
 */

import { hasFirecrawlApiKey, hasExaApiKey } from "../../../shared/config.ts";
import { search as firecrawlSearch, fetch as firecrawlFetch } from "./firecrawl.ts";
import { search as exaSearch } from "./exa.ts";
import type { SearchParams, SearchResult, FetchParams, FetchResult } from "./firecrawl.ts";

function chooseSearchProvider(): "firecrawl" | "exa" {
	const available: Array<"firecrawl" | "exa"> = [];

	if (hasFirecrawlApiKey()) available.push("firecrawl");
	if (hasExaApiKey()) available.push("exa");

	if (available.length === 0) {
		throw new Error(
			"No search provider configured. " +
				"Set FIRECRAWL_API_KEY or EXA_API_KEY, " +
				"or add firecrawl.apiKey / exa.apiKey in pix-config.json.",
		);
	}

	// 随机分配，分散请求压力
	return available[Math.floor(Math.random() * available.length)];
}

export async function search(params: SearchParams): Promise<SearchResult[]> {
	return chooseSearchProvider() === "firecrawl"
		? firecrawlSearch(params)
		: exaSearch(params);
}

export async function fetch(params: FetchParams): Promise<FetchResult> {
	return firecrawlFetch(params);
}
