/**
 * Firecrawl service layer — search 和 fetch 的 SDK 封装。
 *
 * FetchParams / FetchResult 类型由 service/index.ts 定义。
 * 本文件导出 search() 和 fetch() 供路由层调用。
 */

import { Firecrawl } from "firecrawl";
import { getFirecrawlApiKey } from "../config.ts";
import type { FetchParams, FetchResult } from "./index.ts";

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 0;

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

// ============================================================================
// Client 单例（懒加载，API key 来自 pix 配置文件）
// ============================================================================

let clientInstance: Firecrawl | undefined;

/** 获取全局单例 Firecrawl 客户端 */
export function getFirecrawlClient(): Firecrawl {
	if (clientInstance) return clientInstance;
	const apiKey = getFirecrawlApiKey();
	if (!apiKey) {
		throw new Error("Firecrawl API key not configured");
	}
	clientInstance = new Firecrawl({
		apiKey,
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

/**
 * 抓取单个 URL 并返回 markdown 内容。
 * onlyMainContent 固定为 true（"只提取主内容"是全局策略）。
 */
export async function fetch(params: FetchParams): Promise<FetchResult> {
	const firecrawl = getFirecrawlClient();

	const doc = await firecrawl.scrape(params.url, {
		formats: ["markdown"],
		onlyMainContent: true,
	});
	const meta = doc.metadata;

	return {
		markdown: doc.markdown ?? "",
		title: meta?.title,
		sourceURL: meta?.sourceURL,
		statusCode: meta?.statusCode,
	};
}
