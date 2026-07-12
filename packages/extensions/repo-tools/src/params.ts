/**
 * Tool 参数解析 — GitHub URL / repo+number / cwd 推断。
 */

import { inferRepoFromCwd } from "./git-remote.ts";

// ============================================================================
// 类型
// ============================================================================

export interface GitHubRepo {
	owner: string;
	repo: string;
}

export interface ResolvedIssue {
	owner: string;
	repo: string;
	number: number;
}

// ============================================================================
// URL 解析
// ============================================================================

export function parseGitHubUrl(
	url: string,
): { owner: string; repo: string; number?: number } | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}

	if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
		return null;
	}

	const parts = u.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;

	const result: { owner: string; repo: string; number?: number } = {
		owner: parts[0],
		repo: parts[1],
	};

	// /owner/repo/issues/123 或 /owner/repo/pull/123
	if (
		(parts[2] === "issues" || parts[2] === "pull") &&
		parts[3]
	) {
		const n = parseInt(parts[3], 10);
		if (Number.isFinite(n) && n > 0) {
			result.number = n;
		}
	}

	return result;
}

// ============================================================================
// 通用参数解析
// ============================================================================

export interface IssueParams {
	url?: string;
	repo?: string;
	number?: number;
}

/**
 * 解析 issue/PR 参数。
 *
 * 优先级：url → repo+number → number+cwd 推断
 */
export async function resolveIssueParams(
	params: IssueParams,
): Promise<ResolvedIssue> {
	// 1. 完整 URL
	if (params.url) {
		const parsed = parseGitHubUrl(params.url);
		if (!parsed) {
			throw new Error(
				`无效的 GitHub URL: ${params.url}。需要类似 https://github.com/owner/repo/issues/123 的格式。`,
			);
		}
		if (!parsed.number) {
			throw new Error(
				`URL 中未找到 issue/PR 编号: ${params.url}。需要包含 /issues/123 或 /pull/456。`,
			);
		}
		return { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
	}

	// 2. repo + number
	if (params.repo && params.number) {
		const [owner, repo] = params.repo.split("/");
		if (!owner || !repo) {
			throw new Error(
				`无效的 repo 格式: ${params.repo}。需要 "owner/repo" 格式。`,
			);
		}
		return { owner, repo, number: params.number };
	}

	// 3. 仅 number → cwd 推断
	if (params.number && !params.repo) {
		const inferred = await inferRepoFromCwd();
		if (!inferred) {
			throw new Error(
				"无法推断 GitHub 仓库。请提供 url 参数，或 repo+number 参数，或在 git 仓库中运行。",
			);
		}
		return { ...inferred, number: params.number };
	}

	// 4. 只有 repo → 报错
	if (params.repo && !params.number) {
		const [owner, repo] = params.repo.split("/");
		if (!owner || !repo) {
			throw new Error(
				`无效的 repo 格式: ${params.repo}。需要 "owner/repo" 格式。`,
			);
		}
		// 自动从 cwd 推断 number？不合理，报错
		throw new Error(
			"需要提供 number 参数（issue/PR 编号），或完整的 GitHub URL。",
		);
	}

	throw new Error(
		"需要提供 url（完整 GitHub URL）、repo+number（owner/repo 加编号），或至少 number（在 git 仓库中运行）。",
	);
}
