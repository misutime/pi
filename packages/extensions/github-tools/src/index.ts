/**
 * github-tools — GitHub 仓库能力扩展（只读）。
 *
 * 提供仓库结构查看、issue/PR 查看、diff 获取、跨仓库代码搜索。
 * 优先使用 gh CLI，fallback GitHub REST API。
 *
 * 在 extensions.toml 中配置 githubToken 或设置 GITHUB_TOKEN 环境变量即可用。
 * 安装 gh CLI 并登录可获得最佳体验（私有仓库、更高频率限制）。
 *
 * extensions.toml 示例:
 *   [github-tools]
 *   githubToken = "ghp_xxxxx"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import githubIssueView from "./github-issue-view.ts";
import githubPrView from "./github-pr-view.ts";
import githubPrDiff from "./github-pr-diff.ts";
import githubRepoView from "./github-repo-view.ts";
import githubCodeSearch from "./github-code-search.ts";

export default function repoTools(pi: ExtensionAPI): void {
	githubRepoView(pi);
	githubIssueView(pi);
	githubPrView(pi);
	githubPrDiff(pi);
	githubCodeSearch(pi);
}
