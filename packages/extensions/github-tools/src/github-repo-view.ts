/**
 * github_repo_view — 查看 GitHub 仓库结构和文件内容。
 *
 * 核心场景："这个项目用的什么架构"、"看看 README"、"src/ 里有什么文件"。
 *
 * 优先 gh，fallback REST API。支持：
 *   - 仓库首页 → 返回 tree + README
 *   - 目录路径 → 返回目录列表
 *   - 文件路径 → 返回文件内容
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tryGh, restApi } from "./client.ts";
import { inferRepoFromCwd } from "./git-remote.ts";

// ============================================================================
// 类型
// ============================================================================

interface GhTreeItem {
	path: string;
	type: "blob" | "tree";
}

interface GhContent {
	type: "file" | "dir" | "symlink";
	name: string;
	path: string;
	size?: number;
	content?: string; // file: base64
	encoding?: string; // "base64"
}

// ============================================================================
// 常量
// ============================================================================

const MAX_TREE_ITEMS = 200;
const MAX_FILE_CHARS = 60_000;
const MAX_README_CHARS = 16_000;

// 忽略的目录（和 pi-web-access 一致）
const NOISE_DIRS = new Set([
	"node_modules", "vendor", ".next", "dist", "build", "__pycache__",
	".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
	"target", ".gradle", ".idea", ".vscode", ".git",
]);

// ============================================================================
// URL 解析
// ============================================================================

// 非代码路径段（issue/PR/讨论/wiki 等），解析到后提示用户用对应工具
const NON_CODE_SEGMENTS = new Set([
	"issues", "pull", "pulls", "discussions", "releases", "wiki",
	"actions", "settings", "security", "projects", "graphs",
	"compare", "commits", "tags", "branches", "stargazers",
	"watchers", "network", "forks", "milestone", "labels",
	"packages", "codespaces", "contribute", "community",
	"sponsors", "invitations", "notifications", "insights",
]);

function parseRepoUrl(url: string): { owner: string; repo: string; ref?: string; path?: string; type?: "blob" | "tree" } | "non_code" | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}

	if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;

	const parts = u.pathname.split("/").filter(Boolean).map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	});
	if (parts.length < 2) return null;

	// 检测非代码路径，提示用户用对应工具
	if (NON_CODE_SEGMENTS.has(parts[2]?.toLowerCase())) return "non_code";

	const result: { owner: string; repo: string; ref?: string; path?: string; type?: "blob" | "tree" } = {
		owner: parts[0],
		repo: parts[1].replace(/\.git$/, ""),
	};

	if (parts.length >= 3 && (parts[2] === "blob" || parts[2] === "tree")) {
		result.type = parts[2];
		// 注意：暂不支持 ref 含 / 的 URL（如 /blob/feature/foo/src/a.ts）。
		// 这种情况下 ref 会被误判——请改用 repo + path 参数模式。
		if (parts.length >= 4) result.ref = parts[3];
		if (parts.length >= 5) result.path = parts.slice(4).join("/");
	}

	return result;
}

// ============================================================================
// 树
// ============================================================================

async function fetchTree(
	owner: string,
	repo: string,
	ref: string,
	signal?: AbortSignal,
): Promise<GhTreeItem[]> {
	// gh
	const ghJson = await tryGh([
		"api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
		"--jq", ".tree",
	], signal);

	if (ghJson !== null) {
		return JSON.parse(ghJson) as GhTreeItem[];
	}

	// REST
	const text = await restApi(
		`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
		{ signal },
	);
	const data = JSON.parse(text);
	return (data.tree as GhTreeItem[]) ?? [];
}

async function fetchDefaultBranch(owner: string, repo: string): Promise<string> {
	// gh
	const branch = await tryGh([
		"api", `repos/${owner}/${repo}`,
		"--jq", ".default_branch",
	]);
	if (branch) return branch;

	// REST
	const text = await restApi(`/repos/${owner}/${repo}`);
	const data = JSON.parse(text);
	return (data.default_branch as string) || "main";
}

// ============================================================================
// README
// ============================================================================

async function fetchReadme(
	owner: string,
	repo: string,
	ref: string,
	signal?: AbortSignal,
): Promise<string | null> {
	// gh — 直接拿 base64 content
	const ghContent = await tryGh([
		"api", `repos/${owner}/${repo}/readme?ref=${ref}`,
		"--jq", ".content",
	], signal);

	if (ghContent !== null) {
		try {
			return Buffer.from(ghContent, "base64").toString("utf-8");
		} catch {
			return null;
		}
	}

	// REST
	try {
		const text = await restApi(`/repos/${owner}/${repo}/readme?ref=${ref}`, {
			signal,
		});
		const data = JSON.parse(text);
		if (data.content && data.encoding === "base64") {
			return Buffer.from(data.content as string, "base64").toString("utf-8");
		}
	} catch {
		// 没有 README 很正常
	}
	return null;
}

// ============================================================================
// 目录列表 / 文件内容
// ============================================================================

async function fetchContent(
	owner: string,
	repo: string,
	path: string,
	ref: string,
	signal?: AbortSignal,
): Promise<GhContent | GhContent[] | null> {
	// gh
	const ghJson = await tryGh([
		"api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
	], signal);

	if (ghJson !== null) {
		return JSON.parse(ghJson) as GhContent | GhContent[];
	}

	// REST
	try {
		const text = await restApi(
			`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`,
			{ signal },
		);
		return JSON.parse(text) as GhContent | GhContent[];
	} catch {
		return null;
	}
}

// ============================================================================
// 格式化
// ============================================================================

function formatTree(tree: GhTreeItem[]): string {
	if (tree.length === 0) return "（空仓库）";

	// 按根目录分组，过滤噪声目录
	const topLevel: string[] = [];
	const seen = new Set<string>();

	for (const item of tree) {
		const parts = item.path.split("/");
		const top = parts[0];

		if (NOISE_DIRS.has(top)) {
			if (!seen.has(top)) {
				seen.add(top);
				topLevel.push(`${top}/  [已跳过]`);
			}
			continue;
		}

		if (parts.length === 1) {
			if (!seen.has(item.path)) {
				seen.add(item.path);
				topLevel.push(item.path + (item.type === "tree" ? "/" : ""));
			}
		} else {
			if (!seen.has(top)) {
				seen.add(top);
				topLevel.push(top + "/");
			}
		}
	}

	topLevel.sort();

	const lines: string[] = [];
	if (topLevel.length >= MAX_TREE_ITEMS) {
		lines.push(...topLevel.slice(0, MAX_TREE_ITEMS));
		lines.push(`...（截断于 ${MAX_TREE_ITEMS} 项，共 ${topLevel.length} 项）`);
	} else {
		lines.push(...topLevel);
	}

	return lines.join("\n");
}

function formatDirListing(items: GhContent[]): string {
	if (!Array.isArray(items)) return "";
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "dir") {
			lines.push(`${item.name}/`);
		} else if (item.type === "file") {
			const size = item.size != null ? `  (${formatSize(item.size)})` : "";
			lines.push(`${item.name}${size}`);
		}
	}
	return lines.join("\n");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text: string, maxLen: number, label: string): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + `\n\n[${label}截断于 ${maxLen} 字符]`;
}

// ============================================================================
// 核心逻辑
// ============================================================================

/** 自动检测路径类型（文件/目录）并格式化输出 */
function formatPathContent(path: string, content: GhContent | GhContent[] | null): string {
	const lines: string[] = [];

	if (!content) {
		lines.push(`路径 \`${path}\` 不存在或无法读取。`);
		return lines.join("\n");
	}

	// 目录
	if (Array.isArray(content)) {
		lines.push(`## \`${path}/\``);
		lines.push("");
		lines.push(formatDirListing(content));
		return lines.join("\n");
	}

	// 文件
	if (content.type === "file" || content.type === "symlink") {
		const isBinary = !content.content;
		if (isBinary) {
			lines.push(`## \`${path}\``);
			const size = content.size != null ? `，${formatSize(content.size)}` : "";
			lines.push(`（二进制文件${size}）`);
			return lines.join("\n");
		}

		try {
			const decoded = content.encoding === "base64"
				? Buffer.from(content.content!, "base64").toString("utf-8")
				: content.content!;
			lines.push(`## \`${path}\``);
			lines.push("");
			lines.push(truncate(decoded, MAX_FILE_CHARS, "文件"));
		} catch {
			lines.push(`## \`${path}\``);
			lines.push("（文件内容无法解码）");
		}
		return lines.join("\n");
	}

	lines.push(`路径 \`${path}\` 的类型未知。`);
	return lines.join("\n");
}

async function buildRepoView(
	owner: string,
	repo: string,
	ref: string,
	subPath?: string,
	subType?: "blob" | "tree",
	signal?: AbortSignal,
): Promise<string> {
	const lines: string[] = [];

	// ---- 文件视图 ----
	if (subType === "blob" && subPath) {
		const content = await fetchContent(owner, repo, subPath, ref, signal);
		if (content && !Array.isArray(content) && content.type === "file" && content.content) {
			try {
				const decoded = content.encoding === "base64"
					? Buffer.from(content.content, "base64").toString("utf-8")
					: content.content;
				lines.push(`## \`${subPath}\``);
				lines.push("");
				lines.push(truncate(decoded, MAX_FILE_CHARS, "文件"));
			} catch {
				lines.push(`## \`${subPath}\``);
				lines.push(`（二进制文件，${content.size != null ? formatSize(content.size) : "未知大小"}）`);
			}
		} else {
			lines.push(`## \`${subPath}\``);
			lines.push("（文件不存在或无法读取）");
		}
		return lines.join("\n");
	}

	// ---- 目录视图 ----
	if (subType === "tree" && subPath) {
		const dirPath = subPath;
		const content = await fetchContent(owner, repo, dirPath, ref, signal);
		if (Array.isArray(content)) {
			lines.push(`## \`${dirPath}/\``);
			lines.push("");
			lines.push(formatDirListing(content));
		} else {
			lines.push(`路径 \`${dirPath}\` 不存在或不是目录。`);
		}
		return lines.join("\n");
	}

	// ---- 路径视图（subType 未知时自动检测文件/目录）----
	if (subPath && subType === undefined) {
		const content = await fetchContent(owner, repo, subPath, ref, signal);
		return formatPathContent(subPath, content);
	}

	// ---- 仓库首页视图 ----
	// 并行拉 tree 和 README
	const [tree, readme] = await Promise.all([
		fetchTree(owner, repo, ref, signal),
		fetchReadme(owner, repo, ref, signal),
	]);

	lines.push(`## ${owner}/${repo} 仓库结构`);
	lines.push("");
	lines.push(formatTree(tree));

	if (readme) {
		lines.push("");
		lines.push("---");
		lines.push("## README.md");
		lines.push("");
		lines.push(truncate(readme, MAX_README_CHARS, "README"));
	}

	return lines.join("\n");
}

async function resolveRepo(params: {
	url?: string;
	repo?: string;
	path?: string;
}): Promise<{
	owner: string;
	repo: string;
	ref: string;
	subPath?: string;
	subType?: "blob" | "tree";
}> {
	// 1. 完整 URL
	if (params.url) {
		const parsed = parseRepoUrl(params.url);
		if (parsed === "non_code") {
			const pathParts = new URL(params.url!).pathname.split("/").filter(Boolean);
			const segment = pathParts[2] ?? "?";
			const hint = segment === "issues" || segment === "pull" || segment === "pulls" ?
				"请使用 github_issue_view 或 github_pr_view 查看。" :
				"这不是代码仓库页面，github_repo_view 不支持此 URL 类型。";
			throw new Error(
				`此 URL 指向 GitHub ${segment} 页面，不是代码仓库页面。${hint}`,
			);
		}
		if (!parsed) {
			throw new Error(
				`无效的 GitHub URL: ${params.url}。需要 https://github.com/owner/repo 格式。`,
			);
		}
		return {
			owner: parsed.owner,
			repo: parsed.repo,
			ref: parsed.ref ?? await fetchDefaultBranch(parsed.owner, parsed.repo),
			subPath: parsed.path,
			subType: parsed.type,
		};
	}

	// 2. owner/repo
	if (params.repo) {
		const [owner, repo] = params.repo.split("/");
		if (!owner || !repo) {
			throw new Error(
				`无效的 repo 格式: ${params.repo}。需要 "owner/repo" 格式。`,
			);
		}
		return {
			owner,
			repo,
			ref: await fetchDefaultBranch(owner, repo),
			subPath: params.path,
		};
	}

	// 3. cwd 推断
	const inferred = await inferRepoFromCwd();
	if (!inferred) {
		throw new Error(
			"无法推断 GitHub 仓库。请提供 url 参数（完整 GitHub URL）或 repo 参数（owner/repo 格式）。",
		);
	}
	return {
		owner: inferred.owner,
		repo: inferred.repo,
		ref: await fetchDefaultBranch(inferred.owner, inferred.repo),
		subPath: params.path,
	};
}

// ============================================================================
// Tool 注册
// ============================================================================

export default function githubRepoView(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "github_repo_view",
		label: "GitHub Repo View",
		description:
			"查看 GitHub 仓库结构、README 和文件内容。" +
			" 可用于快速了解项目架构、查看目录树、或读取特定文件。" +
			" 支持完整 URL、owner/repo 格式、或自动推断当前工作目录的 git 仓库。" +
			" 注：URL 模式暂不支持含 / 的分支名（如 /blob/feature/foo/src/a.ts），" +
			" 请改用 repo + path 参数。",
		promptSnippet: "Use to explore a GitHub repository's structure, README, and file contents.",
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"完整的 GitHub URL。可以是仓库首页（https://github.com/owner/repo）、" +
						"目录页（.../tree/main/src）或文件页（.../blob/main/src/main.rs）。",
				}),
			),
			repo: Type.Optional(
				Type.String({
					description: '仓库名（owner/repo 格式），如 "microsoft/typescript"。如未提供 url，此参数必填。',
				}),
			),
			path: Type.Optional(
				Type.String({
					description: "仓库内的路径（文件或目录）。仅在 repo 参数模式下使用（url 模式会自动解析路径）。",
				}),
			),
		}),
		execute: async (
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<Record<string, unknown>>> => {
			const resolved = await resolveRepo(params as {
				url?: string;
				repo?: string;
				path?: string;
			});

			const text = await buildRepoView(
				resolved.owner,
				resolved.repo,
				resolved.ref,
				resolved.subPath,
				resolved.subType,
				signal,
			);

			return {
				content: [{ type: "text", text }],
				details: {
					owner: resolved.owner,
					repo: resolved.repo,
					ref: resolved.ref,
					path: resolved.subPath ?? null,
					type: resolved.subType ?? "root",
				},
			};
		},
	});
}
