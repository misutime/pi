/**
 * Exa service layer — search via Exa API。
 *
 * 与 firecrawl.ts 保持相同接口签名，方便 tool registration 层互换。
 *
 * 注意：Exa 是纯搜索服务，没有独立的 scrape/fetch 端点。
 * 页面内容可通过 `contents.text` 在搜索时一并获取，但 fetch() 不适用于 Exa。
 */

import { Exa } from "exa-js";
import { getExaApiKey } from "../../../shared/config.ts";
import type { SearchParams, SearchResponse } from "./firecrawl.ts";

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
