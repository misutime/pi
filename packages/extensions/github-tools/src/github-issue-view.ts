/**
 * github_issue_view — 查看 GitHub issue 详情（含评论）。
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tryGh, restApi } from "./client.ts";
import { resolveIssueParams } from "./params.ts";

// ============================================================================
// 类型
// ============================================================================

interface GhIssue {
	title: string;
	body: string;
	state: string;
	number: number;
	url: string;
	author: { login: string };
	createdAt: string;
	updatedAt: string;
	labels: Array<{ name: string }>;
}

interface GhComment {
	author: { login: string };
	body: string;
	createdAt: string;
}

// ============================================================================
// REST 字段规范化
// ============================================================================

/** REST API 返回 snake_case，映射成 gh CLI 的 camelCase 形状 */
function normalizeIssue(raw: Record<string, unknown>): GhIssue {
	return {
		title: String(raw.title ?? ""),
		body: String(raw.body ?? ""),
		state: String(raw.state ?? ""),
		number: Number(raw.number ?? 0),
		url: String(raw.html_url ?? raw.url ?? ""),
		author: { login: String((raw.user as Record<string, unknown> | null)?.login ?? "") },
		createdAt: String(raw.created_at ?? ""),
		updatedAt: String(raw.updated_at ?? ""),
		labels: (raw.labels as Array<{ name?: string }> | null)?.map(l => ({ name: String(l.name ?? "") })) ?? [],
	};
}

function normalizeComment(raw: Record<string, unknown>): GhComment {
	return {
		author: { login: String((raw.user as Record<string, unknown> | null)?.login ?? "") },
		body: String(raw.body ?? ""),
		createdAt: String(raw.created_at ?? ""),
	};
}

// ============================================================================
// 数据获取
// ============================================================================

async function fetchIssue(
	owner: string,
	repo: string,
	number: number,
	signal?: AbortSignal,
): Promise<{ issue: GhIssue; comments: GhComment[] }> {
	// 1. 尝试 gh
	const ghJson = await tryGh([
		"issue", "view", String(number),
		"-R", `${owner}/${repo}`,
		"--json", "title,body,state,number,url,author,createdAt,updatedAt,labels",
	], signal);

	const ghCommentsJson = await tryGh([
		"issue", "view", String(number),
		"-R", `${owner}/${repo}`,
		"--comments",
		"--json", "comments",
	], signal);

	if (ghJson && ghCommentsJson) {
		const issue: GhIssue = JSON.parse(ghJson);
		const raw = JSON.parse(ghCommentsJson);
		return {
			issue,
			comments: (raw.comments as GhComment[]) ?? [],
		};
	}

	// 2. 回退 REST API
	const [issueText, commentsText] = await Promise.all([
		restApi(`/repos/${owner}/${repo}/issues/${number}`, { signal }),
		restApi(`/repos/${owner}/${repo}/issues/${number}/comments`, { signal }),
	]);

	const rawIssue = JSON.parse(issueText);
	const rawComments = JSON.parse(commentsText) as Record<string, unknown>[];

	return {
		issue: normalizeIssue(rawIssue as Record<string, unknown>),
		comments: rawComments.map(normalizeComment),
	};
}

// ============================================================================
// 格式化
// ============================================================================

function formatIssue(issue: GhIssue, comments: GhComment[]): string {
	const labels = issue.labels?.map((l) => l.name).join(", ") || "";
	const createdAt = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString("zh-CN") : "?";
	const updatedAt = issue.updatedAt ? new Date(issue.updatedAt).toLocaleDateString("zh-CN") : "?";

	const lines: string[] = [];

	lines.push(`## Issue #${issue.number}: ${issue.title}`);
	lines.push("");
	lines.push(`- **状态**: ${issue.state}`);
	lines.push(`- **作者**: @${issue.author?.login ?? "?"}`);
	lines.push(`- **创建**: ${createdAt}`);
	lines.push(`- **更新**: ${updatedAt}`);
	if (labels) lines.push(`- **标签**: ${labels}`);
	lines.push(`- **URL**: ${issue.url}`);
	lines.push("");

	if (issue.body) {
		lines.push(truncate(issue.body, 50_000));
		lines.push("");
	}

	if (comments.length > 0) {
		lines.push("---");
		lines.push(`### 评论 (${comments.length})`);
		lines.push("");
		for (const c of comments) {
			const date = c.createdAt
				? new Date(c.createdAt).toLocaleDateString("zh-CN")
				: "?";
			lines.push(`**@${c.author?.login ?? "?"}** (${date}):`);
			lines.push(truncate(c.body, 20_000));
			lines.push("");
		}
	}

	return lines.join("\n");
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + `\n\n[内容截断于 ${maxLen} 字符]`;
}

// ============================================================================
// Tool 注册
// ============================================================================

export default function githubIssueView(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "github_issue_view",
		label: "GitHub Issue View",
		description:
			"查看 GitHub issue 的详细内容，包括标题、正文、状态、标签、作者、评论。" +
			" 可通过完整 URL、owner/repo+编号、或仅编号（在 git 仓库中运行时自动推断仓库）来指定 issue。",
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"完整的 GitHub issue URL，如 https://github.com/owner/repo/issues/123",
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
						"Issue 编号。如果提供了 url 则忽略；如果仅提供 number，会从当前目录的 git remote 推断仓库。",
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

			const { issue, comments } = await fetchIssue(
				resolved.owner,
				resolved.repo,
				resolved.number,
				signal,
			);

			const text = formatIssue(issue, comments);

			return {
				content: [{ type: "text", text }],
				details: {
					owner: resolved.owner,
					repo: resolved.repo,
					number: resolved.number,
					state: issue.state,
				},
			};
		},
	});
}
