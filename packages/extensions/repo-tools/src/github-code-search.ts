/**
 * github_code_search — 搜索公开 GitHub 代码。
 *
 * 优先 gh search code，fallback GitHub REST /search/code。
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tryGh, restApi } from "./client.ts";

// ============================================================================
// 类型
// ============================================================================

interface CodeResult {
	repository: { fullName: string };
	path: string;
	url: string;
}

// ============================================================================
// 构建查询
// ============================================================================

function buildSearchQuery(params: {
	query: string;
	language?: string;
	repo?: string;
	path?: string;
}): string {
	const parts: string[] = [params.query];

	if (params.language) {
		parts.push(`language:${params.language}`);
	}
	if (params.repo) {
		parts.push(`repo:${params.repo}`);
	}
	if (params.path) {
		parts.push(`path:${params.path}`);
	}

	return parts.join(" ");
}

// ============================================================================
// 数据获取
// ============================================================================

async function fetchCodeSearch(
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<CodeResult[]> {
	// 1. gh
	const ghJson = await tryGh([
		"search", "code", query,
		"--json", "repository,path,url",
		"--limit", String(limit),
	], signal);

	if (ghJson !== null) {
		const results: CodeResult[] = JSON.parse(ghJson);
		return results;
	}

	// 2. REST fallback
	const enc = encodeURIComponent(query);
	const text = await restApi(
		`/search/code?q=${enc}&per_page=${Math.min(limit, 100)}`,
		{ signal },
	);
	const data = JSON.parse(text);
	return (data.items as CodeResult[]) ?? [];
}

// ============================================================================
// 格式化
// ============================================================================

function formatResults(
	results: CodeResult[],
	query: string,
	params: {
		language?: string;
		repo?: string;
		path?: string;
	},
): string {
	if (results.length === 0) {
		return `未找到匹配 "${query}" 的代码结果。`;
	}

	const filters: string[] = [];
	if (params.language) filters.push(`语言: ${params.language}`);
	if (params.repo) filters.push(`仓库: ${params.repo}`);
	if (params.path) filters.push(`路径: ${params.path}`);
	const filterStr = filters.length > 0 ? `（${filters.join("，")}）` : "";

	const lines: string[] = [];
	lines.push(`找到 ${results.length} 个结果 "${query}"${filterStr}：`);
	lines.push("");

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(
			`${i + 1}. **${r.repository?.fullName ?? "?"}**: \`${r.path}\``,
		);
		lines.push(`   ${r.url}`);
	}

	return lines.join("\n");
}

// ============================================================================
// Tool 注册
// ============================================================================

const MAX_LIMIT = 20;

export default function githubCodeSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "github_code_search",
		label: "GitHub Code Search",
		description:
			"跨仓库搜索公开 GitHub 代码。支持按语言、仓库、路径过滤。" +
			" 用于查找 API 用法、实现模式、配置示例等。" +
			" 注：GitHub code search 是 legacy engine，不支持正则。",
		parameters: Type.Object({
			query: Type.String({ description: "搜索查询（支持 GitHub search syntax）" }),
			language: Type.Optional(
				Type.String({ description: "编程语言过滤，如 typescript, python, rust" }),
			),
			repo: Type.Optional(
				Type.String({
					description: '限定仓库（owner/repo 格式），如 "microsoft/typescript"',
				}),
			),
			path: Type.Optional(
				Type.String({ description: "限定路径前缀，如 src/" }),
			),
			limit: Type.Optional(
				Type.Integer({
					description: `最大结果数（默认: 10，上限: ${MAX_LIMIT}）`,
					minimum: 1,
					maximum: MAX_LIMIT,
				}),
			),
		}),
		execute: async (
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<Record<string, unknown>>> => {
			const query = buildSearchQuery({
				query: params.query as string,
				language: params.language as string | undefined,
				repo: params.repo as string | undefined,
				path: params.path as string | undefined,
			});

			const limit = (params.limit as number) ?? 10;

			const results = await fetchCodeSearch(query, limit, signal);

			const text = formatResults(results, query, params as {
				language?: string;
				repo?: string;
				path?: string;
			});

			return {
				content: [{ type: "text", text }],
				details: {
					query,
					resultCount: results.length,
				},
			};
		},
	});
}
