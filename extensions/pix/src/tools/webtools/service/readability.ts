/**
 * 本地 Readability fetch provider。
 *
 * 零外部 API 依赖，不花钱，永远不掉线。只处理静态 HTML ——
 * JS 渲染页面内容可能不完整，但作为最后的兜底方案足够了。
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { FetchParams, FetchResult } from "./index.ts";

const TIMEOUT_MS = 20_000;
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_REDIRECTS = 5;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});
turndown.remove(["script", "style", "meta", "link"]);

export async function fetch(params: FetchParams): Promise<FetchResult> {
	// 合并调用方 signal 和自身超时
	const signals: AbortSignal[] = [AbortSignal.timeout(TIMEOUT_MS)];
	if (params.signal) signals.push(params.signal);
	const mergedSignal = AbortSignal.any(signals);

	const fetchHeaders: Record<string, string> = {
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
			"AppleWebKit/537.36 (KHTML, like Gecko) " +
			"Chrome/122.0.0.0 Safari/537.36",
		"Accept":
			"text/markdown;q=1.0, text/x-markdown;q=0.9, " +
			"text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
		"Accept-Language": "en-US,en;q=0.9",
	};

	let response = await manualRedirect(params.url, fetchHeaders, mergedSignal);

	// Cloudflare bot 检测 → 降级到诚实 UA 重试
	if (
		response.status === 403 &&
		response.headers.get("cf-mitigated") === "challenge"
	) {
		response = await manualRedirect(
			params.url,
			{ ...fetchHeaders, "User-Agent": "opencode" },
			mergedSignal,
		);
	}

	// 非 2xx 响应直接抛错，避免把 404/500 错误页当正文返回
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") || "";
	const mime = contentType.split(";")[0]?.trim().toLowerCase() || "";

	// ---- 内容类型分发 ----

	// 图片
	if (mime.startsWith("image/")) {
		return {
			markdown: `![Image](${params.url})`,
			title: `${params.url} (${mime})`,
			sourceURL: params.url,
		};
	}

	// 不支持的类型（在 HTML 判断之前检查，避免 application/* 误杀 XHTML）
	if (
		mime.startsWith("audio/") ||
		mime.startsWith("video/") ||
		mime === "application/octet-stream" ||
		mime === "application/zip"
	) {
		throw new Error(`Unsupported content type: ${mime}`);
	}

	// ---- 流式读取（带大小限制，覆盖 chunked 响应）----
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Response body is not readable");
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_SIZE) {
				await reader.cancel();
				throw new Error(
					`Response too large (>${MAX_SIZE / 1024 / 1024}MB)`,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	// 合并 chunks → 文本
	const total = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		total.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(total);

	// ---- fast path: 服务器直接返回了 markdown ----
	if (mime.includes("text/markdown") || mime.includes("text/x-markdown")) {
		return {
			markdown: text,
			title: extractTitle(text, params.url),
			sourceURL: params.url,
		};
	}

	// ---- 纯文本 ----
	if (mime.startsWith("text/plain")) {
		return {
			markdown: text,
			title: extractTitle(text, params.url),
			sourceURL: params.url,
		};
	}

	// ---- HTML（含 XHTML — 必须在所有 application/* 判断之后）----
	const isHTML = mime === "text/html" || mime === "application/xhtml+xml";
	if (!isHTML) {
		throw new Error(`Unsupported content type: ${mime}`);
	}

	// HTML → Readability + Turndown
	const { document } = parseHTML(text);
	// linkedom 的 document 类型与 Readability 期望的 DOM Document 不完全兼容，
	// 但运行时行为正确。通过 any 桥接。
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const readability = new Readability(document as any);
	const article = readability.parse();

	if (!article) {
		// 诊断：检测是否 SPA
		const scriptCount = (text.match(/<script[\s>]/gi) || []).length;
		const textContent = text
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (textContent.length < 200 && scriptCount > 3) {
			throw new Error(
				"Page is JavaScript-rendered — no content in static HTML",
			);
		}
		throw new Error("Could not extract readable content from page");
	}

	const markdown = turndown.turndown(article.content);

	return {
		markdown,
		title: article.title || undefined,
		sourceURL: params.url,
	};
}

/**
 * 带重定向次数限制的 fetch。
 * 不使用 SSRF 防护——这是有意的设计决策。
 * 只保留重定向次数限制防止无限循环。
 */
async function manualRedirect(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<Response> {
	let current = url;
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const resp = await globalThis.fetch(current, {
			redirect: "manual",
			signal,
			headers,
		});
		const status = resp.status;
		if (
			status < 300 ||
			status >= 400 ||
			![301, 302, 303, 307, 308].includes(status)
		) {
			return resp;
		}
		if (i === MAX_REDIRECTS) {
			throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
		}
		const location = resp.headers.get("location");
		if (!location) return resp;
		current = new URL(location, current).toString();
	}
	throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

function extractTitle(text: string, url: string): string {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (match) return match[1].replace(/\*+/g, "").trim();
	try {
		return new URL(url).pathname.split("/").pop() ?? url;
	} catch {
		return url;
	}
}
