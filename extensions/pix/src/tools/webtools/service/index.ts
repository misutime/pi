/**
 * Service router — 多 provider 回退策略。
 *
 * - search: firecrawl + exa 随机排列，gemini 固定末尾（成本最高，最后回退）
 * - fetch: firecrawl → jina → readability 顺序回退，含内容有效性校验
 * - 所有 provider 均失败时才抛错
 */

import { hasFirecrawlApiKey, hasExaApiKey, hasGeminiApiKey } from "../../../shared/config.ts";
import { search as firecrawlSearch, fetch as firecrawlFetch } from "./firecrawl.ts";
import { search as exaSearch } from "./exa.ts";
import { search as geminiSearch } from "./gemini.ts";
import { fetch as jinaFetch } from "./jina.ts";
import { fetch as readabilityFetch } from "./readability.ts";
import type { SearchParams, SearchResponse } from "./firecrawl.ts";

// ============================================================================
// Fetch 类型（路由层拥有，provider 实现）
// ============================================================================

export interface FetchParams {
	url: string;
	signal?: AbortSignal;
}

export interface FetchResult {
	markdown: string;
	title?: string;
	sourceURL?: string;
	statusCode?: number;
}

// ============================================================================
// Search（不变）
// ============================================================================

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

// ============================================================================
// Fetch（多 provider 回退链）
// ============================================================================

type FetchProvider = "firecrawl" | "jina" | "readability";

const FETCH_IMPLS: Record<FetchProvider, (p: FetchParams) => Promise<FetchResult>> = {
	firecrawl: firecrawlFetch,
	jina: jinaFetch,
	readability: readabilityFetch,
};

function getFetchProviders(): FetchProvider[] {
	const providers: FetchProvider[] = [];
	if (hasFirecrawlApiKey()) providers.push("firecrawl");
	providers.push("jina");
	providers.push("readability");
	return providers;
}

const MIN_MARKDOWN_LENGTH = 1; // 仅拒绝空字符串，短内容（图片 URL、短文本页）正常通过

export async function fetch(params: FetchParams, signal?: AbortSignal): Promise<FetchResult> {
	const providers = getFetchProviders();
	const errors: string[] = [];

	for (const provider of providers) {
		// Abort 检查 — 用户取消了就不再继续
		if (signal?.aborted) {
			throw new Error(signal.reason ?? "Aborted");
		}

		try {
			const result = await FETCH_IMPLS[provider]({ ...params, signal });

			// 内容有效性校验 — 空 markdown 视为失败，继续回退
			if ((result.markdown ?? "").trim().length < MIN_MARKDOWN_LENGTH) {
				errors.push(`${provider}: returned empty content`);
				continue;
			}

			return result;
		} catch (err) {
			// 任何错误都继续回退。Firecrawl/Jina 的 403/429 可能是 provider
			// 自身的限制，不代表本地 Readability 不能正常抓取。
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${provider}: ${msg}`);
		}
	}

	throw new Error(
		`All fetch providers failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
	);
}
