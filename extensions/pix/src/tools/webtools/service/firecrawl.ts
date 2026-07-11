/**
 * Firecrawl service layer — search 和 fetch 的 SDK 封装。
 *
 * 架构约定：search.ts / fetch.ts 只做工具注册和参数校验，具体功能委托给 service。
 * 未来支持 Exa、Gemini Search 等时，新增 service/exa.ts 保持相同函数签名即可。
 */

import { Firecrawl } from "firecrawl";
import type { ScrapeOptions } from "firecrawl";
import { getFirecrawlApiKey } from "../../../shared/config.ts";

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

// ============================================================================
// Client 单例（懒加载，API key 来自 pix 配置文件）
// ============================================================================

let clientInstance: Firecrawl | undefined;

/** 获取全局单例 Firecrawl 客户端 */
export function getFirecrawlClient(): Firecrawl {
	if (clientInstance) return clientInstance;
	clientInstance = new Firecrawl({
		apiKey: getFirecrawlApiKey(),
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxRetries: MAX_RETRIES,
	});
	return clientInstance;
}

// ============================================================================
// 参数规范化
// ============================================================================

export function normalizeSearchLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
	if (!Number.isFinite(limit)) {
		throw new Error("Search limit must be a finite number.");
	}
	return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

// ============================================================================
// search()
// ============================================================================

export interface SearchParams {
	query: string;
	limit?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
}

export interface SearchResult {
	title: string;
	url: string;
	description: string;
}

/** search() 的返回类型 */
export interface SearchResponse {
	results: SearchResult[];
	/** Gemini 的 LLM 生成答案（Firecrawl/Exa 无此字段） */
	answer?: string;
}

/**
 * 执行 web 搜索，返回格式化的结果列表。
 * 调用方负责 abort signal 集成和内容截断。
 */
export async function search(params: SearchParams): Promise<SearchResponse> {
	const firecrawl = getFirecrawlClient();
	const limit = normalizeSearchLimit(params.limit);

	const data = await firecrawl.search(params.query, {
		limit,
		sources: ["web"],
		...(params.includeDomains ? { includeDomains: params.includeDomains } : {}),
		...(params.excludeDomains ? { excludeDomains: params.excludeDomains } : {}),
	});

	const web = data.web ?? [];

	// web 元素类型为 SearchResultWeb | Document。SearchResultWeb 有 url/title/description，
	// Document 的元数据在 metadata 子对象下。统一用 SearchResultWeb 的形状过滤。
	const results: SearchResult[] = [];
	for (const r of web) {
		if (typeof (r as { url?: unknown }).url !== "string") continue;
		results.push({
			title: (r as { title?: string }).title ?? "Untitled",
			url: (r as { url: string }).url,
			description: (r as { description?: string }).description ?? "",
		});
	}

	return { results };
}

// ============================================================================
// fetch()
// ============================================================================

export interface FetchParams {
	url: string;
	onlyMainContent?: boolean;
	waitFor?: number;
}

export interface FetchResult {
	markdown: string;
	title?: string;
	sourceURL?: string;
	statusCode?: number;
	description?: string;
}

/**
 * 抓取单个 URL 并返回 markdown 内容。
 */
export async function fetch(params: FetchParams): Promise<FetchResult> {
	const firecrawl = getFirecrawlClient();

	const options: ScrapeOptions = {
		formats: ["markdown"],
		onlyMainContent: params.onlyMainContent ?? true,
	};
	if (params.waitFor !== undefined) options.waitFor = params.waitFor;

	const doc = await firecrawl.scrape(params.url, options);
	const meta = doc.metadata;

	return {
		markdown: doc.markdown ?? "",
		title: meta?.title,
		sourceURL: meta?.sourceURL,
		statusCode: meta?.statusCode,
		description: meta?.description,
	};
}
