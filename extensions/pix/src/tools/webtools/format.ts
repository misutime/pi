/**
 * 共享格式化工具 — 内容截断、文档格式化、abort race。
 *
 * 所有 webtools service（firecrawl、exa 等）共用的工具函数。
 */

import {
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// 内容截断
// ============================================================================

/**
 * 对工具输出应用 pi 标准的截断策略。
 */
export function applyTruncation(content: string, label: string): string {
	const result = truncateHead(content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!result.truncated) return content;

	return [
		result.content,
		"",
		`[Output truncated: ${result.outputLines} of ${result.totalLines} lines`,
		`(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).`,
		`Use webfetch tool on the specific URL to read the full ${label}.]`,
	].join("\n");
}

// ============================================================================
// Abort race
// ============================================================================

/**
 * 让工具调用不再等待，但**不保证远端请求停止**。
 *
 * - 语义：abort signal 触发时拒绝 Promise，调用方立即退出
 * - 限制：底层 SDK（Firecrawl/Exa）不支持 AbortSignal，远端请求可能仍在执行
 * - 实际保护：provider 自身的 timeout（如 Firecrawl 30s）比此 race 更可靠
 * - 使用场景：用户按 Esc 中断 / subagent 被父 session 取消 / 网络卡住时避免长时间挂起
 */
export function raceWithAbort<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("Aborted"));
	}

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("Aborted"));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);

		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				cleanup();
				resolve(v);
			},
			(e) => {
				cleanup();
				reject(e);
			},
		);
	});
}
