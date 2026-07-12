/**
 * github_pr_diff — 获取 GitHub PR 的 unified diff。
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tryGh, restApi } from "./client.ts";
import { resolveIssueParams } from "./params.ts";

// ============================================================================
// 常量
// ============================================================================

const MAX_DIFF_CHARS = 100_000;

// ============================================================================
// 数据获取
// ============================================================================

async function fetchDiff(
	owner: string,
	repo: string,
	number: number,
	signal?: AbortSignal,
): Promise<string> {
	// gh pr diff 直接返回 diff 文本
	const diff = await tryGh([
		"pr", "diff", String(number),
		"-R", `${owner}/${repo}`,
		"--color", "never",
	], signal);

	if (diff !== null) return diff;

	// REST fallback — 使用 diff media type
	return restApi(`/repos/${owner}/${repo}/pulls/${number}`, {
		accept: "application/vnd.github.diff",
		signal,
	});
}

// ============================================================================
// Tool 注册
// ============================================================================

export default function githubPrDiff(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "github_pr_diff",
		label: "GitHub PR Diff",
		description:
			"获取 GitHub Pull Request 的 unified diff。超出限制时自动截断。" +
			" 可通过完整 URL、owner/repo+编号、或仅编号（git 仓库中推断）指定 PR。",
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"完整的 GitHub PR URL，如 https://github.com/owner/repo/pull/456",
				}),
			),
			repo: Type.Optional(
				Type.String({
					description: '仓库名（owner/repo 格式），如 "microsoft/typescript"',
				}),
			),
			number: Type.Optional(
				Type.Integer({
					description:
						"PR 编号。如果提供了 url 则忽略；如果仅提供 number，会从当前目录的 git remote 推断仓库。",
					minimum: 1,
				}),
			),
		}),
		execute: async (
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<Record<string, unknown>>> => {
			const resolved = await resolveIssueParams(params as {
				url?: string;
				repo?: string;
				number?: number;
			});

			const diff = await fetchDiff(
				resolved.owner,
				resolved.repo,
				resolved.number,
				signal,
			);

			const truncated = diff.length > MAX_DIFF_CHARS
				? diff.slice(0, MAX_DIFF_CHARS) +
					`\n\n[Diff 截断于 ${MAX_DIFF_CHARS} 字符，完整内容 ${diff.length} 字符]`
				: diff;

			return {
				content: [{ type: "text", text: truncated }],
				details: {
					owner: resolved.owner,
					repo: resolved.repo,
					number: resolved.number,
					totalChars: diff.length,
					truncated: diff.length > MAX_DIFF_CHARS,
				},
			};
		},
	});
}
