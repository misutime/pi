/**
 * Exa service layer — search + contents fetch via Exa API。
 *
 * 与 firecrawl.ts 保持相同接口签名，方便 tool registration 层互换。
 */

import { Exa } from "exa-js";
import { getExaApiKey } from "../config.ts";
import type { SearchParams, SearchResponse } from "./firecrawl.ts";
import type { FetchParams, FetchResult } from "./index.ts";

// ============================================================================
// Client 单例（API key 来自 pix 配置文件）
// ============================================================================

let clientInstance: Exa | undefined;

function getExaClient(): Exa {
	if (clientInstance) return clientInstance;
	const apiKey = getExaApiKey();
	if (!apiKey) {
		throw new Error("Exa API key not configured");
	}
	clientInstance = new Exa(apiKey);
	return clientInstance;
}

// ============================================================================
// search()
// ============================================================================

/**
 * 执行 web 搜索（同 firecrawl.ts 签名）。
 *
 * Exa 没有 limit/includeDomains/excludeDomains 的严格上限。
 */
export async function search(params: SearchParams): Promise<SearchResponse> {
	const exa = getExaClient();

	const response = await exa.search(params.query, {
		numResults: params.limit ?? 10,
		type: "auto",
		contents: { highlights: true },
		...(params.includeDomains
			? { includeDomains: params.includeDomains }
			: {}),
		...(params.excludeDomains
			? { excludeDomains: params.excludeDomains }
			: {}),
	});

	return {
		results: response.results.map((r) => ({
			title: r.title ?? "Untitled",
			url: r.url,
			description: r.highlights?.[0] ?? "",
		})),
	};
}

// ============================================================================
// fetch() — 通过 Exa /contents 端点抓取页面内容
// ============================================================================

/**
 * 抓取单个 URL 的完整文本内容（markdown 格式）。
 *
 * 使用 Exa 的 /contents API，支持 JS 渲染页面、PDF、复杂布局。
 */
export async function fetch(params: FetchParams): Promise<FetchResult> {
	const exa = getExaClient();

	const response = await exa.getContents([params.url], {
		text: true,
	});

	const result = response.results[0];
	if (!result) {
		throw new Error(`Exa getContents returned no results for ${params.url}`);
	}
	if (!result.text?.trim()) {
		throw new Error(`Exa getContents returned empty text for ${params.url}`);
	}

	return {
		markdown: result.text,
		title: result.title ?? undefined,
		sourceURL: result.url,
	};
}
