/**
 * Gemini service layer — web search via Gemini API google_search grounding。
 *
 * 通过 Gemini generateContent + google_search tool 获取搜索结果。
 * 与 firecrawl/exa 不同，Gemini 会生成 LLM 答案 + 引用来源（groundingChunks）。
 * search() 返回 SearchResponse，其中 answer 已插入行内引用标记 [1][2]，
 * results 按对应编号排列，LLM 可直接根据引用编号调用 webfetch。
 */

import { getGeminiApiKey, loadConfig } from "../../../shared/config.ts";
import type { SearchParams, SearchResponse } from "./firecrawl.ts";

// ============================================================================
// 常量
// ============================================================================

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";

// ============================================================================
// 类型
// ============================================================================

interface GeminiChunk {
	web?: { uri?: string; title?: string };
}

interface GeminiSupport {
	segment?: { startIndex?: number; endIndex?: number; text?: string };
	groundingChunkIndices?: number[];
}

interface GeminiResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			groundingChunks?: GeminiChunk[];
			groundingSupports?: GeminiSupport[];
		};
	}>;
}

// ============================================================================
// Citation 插入
// ============================================================================

interface CitationInsertion {
	/** UTF-8 byte offset where the marker should be inserted */
	index: number;
	/** Citation marker string, e.g. "[1][2]" */
	marker: string;
}

/**
 * 从 groundingSupports 构建引用插入列表。
 * 每个 support 对应 answer 文本中的一个 segment，在该 segment 末尾插入引用标记。
 */
function buildCitations(supports: GeminiSupport[]): CitationInsertion[] {
	const insertions: CitationInsertion[] = [];

	for (const support of supports) {
		const segment = support.segment;
		const indices = support.groundingChunkIndices;
		if (!segment || segment.endIndex == null || !indices?.length) continue;

		const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);
		insertions.push({
			index: segment.endIndex,
			marker: sorted.map((i) => `[${i + 1}]`).join(""),
		});
	}

	// 从后往前排序，避免插入时偏移量错乱
	insertions.sort((a, b) => b.index - a.index);
	return insertions;
}

/** 按 UTF-8 字节偏移在文本中插入引用标记 */
function insertCitationMarkers(text: string, insertions: CitationInsertion[]): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	const parts: Uint8Array[] = [];
	let lastIndex = bytes.length;

	for (const insertion of insertions) {
		const pos = Math.min(insertion.index, lastIndex);
		parts.unshift(bytes.subarray(pos, lastIndex));
		parts.unshift(encoder.encode(insertion.marker));
		lastIndex = pos;
	}
	parts.unshift(bytes.subarray(0, lastIndex));

	const totalLen = parts.reduce((s, p) => s + p.length, 0);
	const merged = new Uint8Array(totalLen);
	let offset = 0;
	for (const part of parts) {
		merged.set(part, offset);
		offset += part.length;
	}
	return new TextDecoder().decode(merged);
}

// ============================================================================
// search()
// ============================================================================

function getModel(): string {
	return loadConfig().gemini?.searchModel?.trim() || DEFAULT_MODEL;
}

/** 将 domain 过滤注入查询文本，使用 Google 的 site: / -site: 操作符 */
function buildQuery(params: SearchParams): string {
	let query = params.query;
	if (params.includeDomains?.length) {
		query += ` (${params.includeDomains.map((d) => `site:${d}`).join(" OR ")})`;
	}
	if (params.excludeDomains?.length) {
		query += ` ${params.excludeDomains.map((d) => `-site:${d}`).join(" ")}`;
	}
	return query;
}

export async function search(params: SearchParams): Promise<SearchResponse> {
	const apiKey = getGeminiApiKey();
	if (!apiKey) {
		throw new Error("Gemini API key not configured");
	}
	const model = getModel();

	const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey,
		},
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: buildQuery(params) }] }],
			tools: [{ google_search: {} }],
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 300)}`);
	}

	const data = (await res.json()) as GeminiResponse;
	const candidate = data.candidates?.[0];

	// 原始答案文本
	const rawAnswer =
		candidate?.content?.parts
			?.map((p) => p.text)
			.filter(Boolean)
			.join("\n") ?? "";

	// 插入行内引用 [1][2] 使 LLM 可映射到 sources
	const supports = candidate?.groundingMetadata?.groundingSupports;
	const answer = supports?.length
		? insertCitationMarkers(rawAnswer, buildCitations(supports))
		: rawAnswer || undefined;

	// grounding chunks 作为搜索结果（编号与引用标记对应）
	const limit = params.limit ?? 10;
	const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
	const results = chunks
		.filter(
			(c): c is { web: { uri: string; title?: string } } => !!c.web?.uri,
		)
		.map((c) => ({
			title: c.web!.title || "Untitled",
			url: c.web!.uri,
			description: "",
		}))
		.slice(0, limit);

	return { results, answer: answer || undefined };
}
