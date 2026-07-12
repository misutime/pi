/**
 * GitHub client — gh CLI 优先，GitHub REST API 兜底。
 *
 * 认证：
 *   1. gh CLI 已登录（gh auth status）
 *   2. GITHUB_TOKEN 环境变量
 *   3. extensions.toml [repo-tools].githubToken
 */

import { execFile } from "node:child_process";
import { loadExtensionConfig } from "@pi/extensions-shared/config";

// ============================================================================
// gh CLI 可用性（缓存单次检测结果）
// ============================================================================

let _ghAvailable: boolean | null = null;

export async function checkGhAvailable(): Promise<boolean> {
	if (_ghAvailable !== null) return _ghAvailable;

	return new Promise((resolve) => {
		execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
			_ghAvailable = !err;
			resolve(_ghAvailable);
		});
	});
}

// ============================================================================
// gh CLI 执行
// ============================================================================

const GH_TIMEOUT = 15_000;
const GH_MAX_BUFFER = 5 * 1024 * 1024; // 5MB

export function ghExec(
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("gh", args, {
			timeout: GH_TIMEOUT,
			maxBuffer: GH_MAX_BUFFER,
			signal,
		}, (err, stdout, stderr) => {
			if (err) {
				const msg = stderr.trim() || err.message;
				reject(new Error(msg));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

/**
 * 尝试用 gh 执行命令，失败或不可用返回 null（不抛异常）。
 */
export async function tryGh(
	args: string[],
	signal?: AbortSignal,
): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;
	try {
		return await ghExec(args, signal);
	} catch {
		return null;
	}
}

// ============================================================================
// GitHub token
// ============================================================================

export function getGitHubToken(): string | undefined {
	// 1. GITHUB_TOKEN 环境变量
	const env = process.env["GITHUB_TOKEN"]?.trim();
	if (env) return env;

	// 2. extensions.toml [repo-tools].githubToken
	try {
		const config = loadExtensionConfig("repo-tools");
		const token = (config as Record<string, unknown>).githubToken;
		if (typeof token === "string" && token.trim()) return token.trim();
	} catch {
		// 配置不存在或格式错误，回退
	}

	return undefined;
}

// ============================================================================
// GitHub REST API
// ============================================================================

export async function restApi(
	endpoint: string,
	opts?: { accept?: string; signal?: AbortSignal },
): Promise<string> {
	const token = getGitHubToken();
	const headers: Record<string, string> = {
		"User-Agent": "pi-repo-tools",
		"Accept": opts?.accept ?? "application/vnd.github+json",
	};
	if (token) headers["Authorization"] = `Bearer ${token}`;

	const resp = await fetch(`https://api.github.com${endpoint}`, {
		headers,
		signal: opts?.signal,
	});

	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(
			`GitHub API ${resp.status}: ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
		);
	}

	return resp.text();
}
