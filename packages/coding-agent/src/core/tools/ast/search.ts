import { createInterface } from "node:readline";
import { spawn } from "child_process";
import { ensureTool } from "../../../utils/tools-manager.ts";
import type { PatternMatch, Position } from "./types.ts";

const SG_SPAWN_TIMEOUT_MS = 15_000;

export interface SearchResult {
	matches: PatternMatch[];
	/** true 表示子进程因达到 limit 被 kill，而非自然结束 */
	killedDueToLimit: boolean;
}

/**
 * 通过 spawn `sg` CLI 进行结构化代码搜索。
 *
 * `sg` 二进制由 `tools-manager.ts` 管理（与 fd/rg 同模式），
 * 首次使用时从 GitHub Releases 自动下载平台二进制。
 *
 * 语言推断：单文件搜索时不传 `-l`，由 sg 根据扩展名自推断；
 * 目录搜索或用户显式指定时传 `-l`。
 */
export class StructuralSearch {
	private async _getSgPath(): Promise<string> {
		const path = await ensureTool("sg", true);
		if (!path) {
			throw new Error("sg binary not available. Install ast-grep or ensure network access for auto-download.");
		}
		return path;
	}

	/**
	 * 单文件搜索。sg 根据扩展名自推断语言，除非显式传 language。
	 */
	async search(
		filePath: string,
		pattern: string,
		opts?: { signal?: AbortSignal; limit?: number; language?: string; globs?: string[] },
	): Promise<SearchResult> {
		const args = ["run", "--json=stream", "-p", pattern];
		if (opts?.language) args.push("-l", opts.language);
		if (opts?.globs) {
			for (const g of opts.globs) args.push("--globs", g);
		}
		args.push(filePath);
		return this._spawnSg(args, filePath, opts?.signal, opts?.limit);
	}

	/**
	 * 目录递归搜索。必须传 language。
	 */
	async searchMany(
		rootDir: string,
		pattern: string,
		language: string,
		opts?: { signal?: AbortSignal; limit?: number; globs?: string[] },
	): Promise<SearchResult> {
		const args = ["run", "--json=stream", "-p", pattern, "-l", language];
		if (opts?.globs) {
			for (const g of opts.globs) args.push("--globs", g);
		}
		args.push(rootDir);
		return this._spawnSg(args, rootDir, opts?.signal, opts?.limit);
	}

	// ====================================================================
	// 内部 spawn + 流式解析
	// ====================================================================

	private async _spawnSg(
		args: string[],
		defaultFilePath: string,
		signal?: AbortSignal,
		limit?: number,
	): Promise<SearchResult> {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const sgPath = await this._getSgPath();

		return new Promise<SearchResult>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			const child = spawn(sgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			const rl = createInterface({ input: child.stdout! });
			const matches: PatternMatch[] = [];
			let stderr = "";
			let aborted = false;
			let stopped = false;
			let killedDueToLimit = false;

			const stopChild = () => {
				if (!child.killed) {
					child.kill();
				}
				stopped = true;
			};
			const onAbort = () => {
				aborted = true;
				stopChild();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const timeout = setTimeout(() => {
				stopChild();
			}, SG_SPAWN_TIMEOUT_MS);

			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});

			rl.on("line", (line: string) => {
				if (aborted || stopped) return;
				if (!line.trim()) return;

				if (limit !== undefined && matches.length >= limit) {
					killedDueToLimit = true;
					stopChild();
					rl.close();
					return;
				}

				try {
					const obj = JSON.parse(line) as Record<string, unknown>;
					const matchFilePath = typeof obj.file === "string" ? obj.file : defaultFilePath;
					const match = this._parseMatchNode(obj, matchFilePath);
					if (match) {
						matches.push(match);
					}
				} catch {
					// Skip unparseable lines.
				}
			});

			child.on("error", (err) => {
				clearTimeout(timeout);
				rl.close();
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Failed to spawn sg: ${err.message}`));
			});

			child.on("close", (code) => {
				clearTimeout(timeout);
				rl.close();
				signal?.removeEventListener("abort", onAbort);

				if (aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				if (!killedDueToLimit && code !== 0) {
					const msg = stderr.trim() || `sg exited with code ${code}`;
					reject(new Error(msg));
					return;
				}
				resolve({ matches, killedDueToLimit });
			});
		});
	}

	private _parseMatchNode(obj: Record<string, unknown>, filePath: string): PatternMatch | null {
		const range = obj.range as Record<string, Record<string, number>> | undefined;
		const text = typeof obj.text === "string" ? obj.text : "";
		const metaVariables = obj.metaVariables as
			| Record<string, Record<string, { text: string } | Array<{ text: string }>>>
			| undefined;

		if (!range?.start || !range?.end) return null;

		// ast-grep 行号为 0-based，+1 转为 1-based
		const start = range.start;
		const end = range.end;
		const startPos: Position = { line: start.line + 1, column: start.column };
		const endPos: Position = { line: end.line + 1, column: end.column };

		const captures: Record<string, string> = {};
		if (metaVariables?.single) {
			for (const [name, val] of Object.entries(metaVariables.single)) {
				if (val && typeof (val as { text: string }).text === "string") {
					captures[name] = (val as { text: string }).text;
				}
			}
		}
		if (metaVariables?.multi) {
			for (const [name, val] of Object.entries(metaVariables.multi)) {
				if (Array.isArray(val)) {
					const texts = val.filter((v) => v && typeof v.text === "string").map((v) => v.text);
					if (texts.length > 0) {
						captures[name] = texts.join(", ");
					}
				} else if (val && typeof (val as { text: string }).text === "string") {
					captures[name] = (val as { text: string }).text;
				}
			}
		}

		return {
			filePath,
			range: { start: startPos, end: endPos },
			text,
			captures,
		};
	}
}
