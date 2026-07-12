/**
 * Jina Reader fetch provider.
 *
 * 免费层：无需 API key，每分钟约 20 次。
 * 配置 JINA_API_KEY 或 pix-config.jsonc 中的 jina.apiKey 可提升速率限制。
 */

import { getJinaApiKey } from "../config.ts";
import type { FetchParams, FetchResult } from "./index.ts";

const JINA_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;

export async function fetch(params: FetchParams): Promise<FetchResult> {
	// 合并调用方 signal 和自身超时
	const signals: AbortSignal[] = [AbortSignal.timeout(JINA_TIMEOUT_MS)];
	if (params.signal) signals.push(params.signal);
	const mergedSignal = AbortSignal.any(signals);

	const headers: Record<string, string> = {
		"Accept": "text/markdown",
		"X-No-Cache": "true",
	};
	const jinaKey = getJinaApiKey();
	if (jinaKey) {
		headers["Authorization"] = `Bearer ${jinaKey}`;
	}

	const response = await globalThis.fetch(JINA_BASE + params.url, {
		headers,
		signal: mergedSignal,
	});

	if (!response.ok) {
		throw new Error(`Jina Reader returned HTTP ${response.status}`);
	}

	const text = await response.text();

	// Jina 返回格式: "Title: ...\n\nMarkdown Content:\n..."
	const idx = text.indexOf("Markdown Content:");
	if (idx < 0) {
		throw new Error("Jina Reader response missing markdown content");
	}

	const markdown = text.slice(idx + 17).trim(); // 17 = "Markdown Content:".length

	if (markdown.trim().length === 0) {
		throw new Error("Jina Reader returned empty content");
	}

	const title = extractTitle(markdown, params.url);

	return { markdown, title, sourceURL: params.url };
}

function extractTitle(markdown: string, fallbackUrl: string): string {
	const match = markdown.match(/^#{1,2}\s+(.+)/m);
	if (match) return match[1].replace(/\*+/g, "").trim();
	try {
		return new URL(fallbackUrl).pathname.split("/").pop() ?? fallbackUrl;
	} catch {
		return fallbackUrl;
	}
}
