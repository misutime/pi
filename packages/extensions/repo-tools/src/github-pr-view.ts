/**
 * github_pr_view — 查看 GitHub PR 详情（含文件变更列表和 review 状态）。
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tryGh, restApi } from "./client.ts";
import { resolveIssueParams } from "./params.ts";

// ============================================================================
// 类型
// ============================================================================

interface GhPR {
	title: string;
	body: string;
	state: string;
	number: number;
	url: string;
	author: { login: string };
	createdAt: string;
	updatedAt: string;
	mergedAt: string | null;
	labels: Array<{ name: string }>;
	reviewDecision: string | null;
	statusCheckRollup: Array<{ name: string; status: string; conclusion: string | null }> | null;
}

interface GhFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
}

// ============================================================================
// 数据获取
// ============================================================================

async function fetchPR(
	owner: string,
	repo: string,
	number: number,
	signal?: AbortSignal,
): Promise<{ pr: GhPR; files: GhFile[] }> {
	// gh 路径
	const ghJson = await tryGh([
		"pr", "view", String(number),
		"-R", `${owner}/${repo}`,
		"--json",
		"title,body,state,number,url,author,createdAt,updatedAt,mergedAt,labels,reviewDecision,statusCheckRollup",
	], signal);

	const ghFilesJson = await tryGh([
		"pr", "view", String(number),
		"-R", `${owner}/${repo}`,
		"--json", "files",
	], signal);

	if (ghJson && ghFilesJson) {
		const pr: GhPR = JSON.parse(ghJson);
		const raw = JSON.parse(ghFilesJson);
		return {
			pr,
			files: (raw.files as GhFile[]) ?? [],
		};
	}

	// REST fallback
	const prText = await restApi(`/repos/${owner}/${repo}/pulls/${number}`, {
		signal,
	});

	// REST 获取 files（直接用 PR 的 files API）
	let filesRaw: string;
	try {
		filesRaw = await restApi(
			`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
			{ signal },
		);
	} catch {
		filesRaw = "[]";
	}

	const pr: GhPR = JSON.parse(prText);
	const files: GhFile[] = JSON.parse(filesRaw);

	return { pr, files };
}

// ============================================================================
// 格式化
// ============================================================================

function formatPR(pr: GhPR, files: GhFile[]): string {
	const labels = pr.labels?.map((l) => l.name).join(", ") || "";
	const createdAt = pr.createdAt
		? new Date(pr.createdAt).toLocaleDateString("zh-CN")
		: "?";
	const updatedAt = pr.updatedAt
		? new Date(pr.updatedAt).toLocaleDateString("zh-CN")
		: "?";

	const lines: string[] = [];

	lines.push(`## PR #${pr.number}: ${pr.title}`);
	lines.push("");

	// 状态
	const stateDisplay = pr.mergedAt
		? "merged"
		: pr.state;
	lines.push(`- **状态**: ${stateDisplay}`);
	lines.push(`- **作者**: @${pr.author?.login ?? "?"}`);
	lines.push(`- **创建**: ${createdAt}`);
	lines.push(`- **更新**: ${updatedAt}`);
	if (pr.mergedAt) {
		lines.push(`- **合并**: ${new Date(pr.mergedAt).toLocaleDateString("zh-CN")}`);
	}
	if (pr.reviewDecision) {
		lines.push(`- **Review**: ${pr.reviewDecision}`);
	}
	if (pr.statusCheckRollup && pr.statusCheckRollup.length > 0) {
		const checks = pr.statusCheckRollup
			.map((c) => {
				const icon = c.conclusion === "SUCCESS"
					? "✅"
					: c.conclusion === "FAILURE"
						? "❌"
						: c.status === "IN_PROGRESS"
							? "⏳"
							: "⬜";
				return `${icon} ${c.name}`;
			})
			.join(", ");
		lines.push(`- **Checks**: ${checks}`);
	}
	if (labels) lines.push(`- **标签**: ${labels}`);
	lines.push(`- **URL**: ${pr.url}`);
	lines.push("");

	if (pr.body) {
		lines.push(truncate(pr.body, 50_000));
		lines.push("");
	}

	if (files.length > 0) {
		lines.push("---");
		lines.push(`### 文件变更 (${files.length})`);
		lines.push("");
		for (const f of files) {
			const indicator = f.status === "added"
				? "A"
				: f.status === "removed"
					? "D"
					: f.status === "renamed"
						? "R"
						: "M";
			lines.push(
				`${indicator} \`${f.filename}\` (+${f.additions}, -${f.deletions})`,
			);
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

export default function githubPrView(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "github_pr_view",
		label: "GitHub PR View",
		description:
			"查看 GitHub Pull Request 的详细信息，包括标题、正文、状态、文件变更、review 和 CI 状态。" +
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

			const { pr, files } = await fetchPR(
				resolved.owner,
				resolved.repo,
				resolved.number,
				signal,
			);

			const text = formatPR(pr, files);

			return {
				content: [{ type: "text", text }],
				details: {
					owner: resolved.owner,
					repo: resolved.repo,
					number: resolved.number,
					state: pr.state,
					merged: !!pr.mergedAt,
					filesChanged: files.length,
				},
			};
		},
	});
}
