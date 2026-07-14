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
 * 通过 spawn `sg` CLI 进行结构化代码搜索与重写。
 *
 * `sg` 二进制由 `tools-manager.ts` 管理（与 fd/rg 同模式），
 * 首次使用时从 GitHub Releases 自动下载平台二进制。
 */
export class StructuralSearch {
	private async _getSgPath(): Promise<string> {
		const path = await ensureTool("sg", true);
		if (!path) {
			throw new Error("sg binary not available. Install ast-grep or ensure network access for auto-download.");
		}
		return path;
	}

	private _extToLang(filePath: string): string | undefined {
		const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
		const map: Record<string, string> = {
			".ts": "typescript",
			".tsx": "tsx",
			".js": "javascript",
			".jsx": "javascript",
			".py": "python",
			".rs": "rust",
			".go": "go",
			".java": "java",
			".kt": "kotlin",
			".c": "c",
			".cpp": "cpp",
			".h": "c",
			".hpp": "cpp",
			".cs": "csharp",
			".rb": "ruby",
			".swift": "swift",
			".lua": "lua",
			".php": "php",
			".html": "html",
			".css": "css",
			".json": "json",
			".yaml": "yaml",
			".yml": "yaml",
		};
		return map[ext];
	}

	async search(filePath: string, pattern: string, signal?: AbortSignal, limit?: number): Promise<SearchResult> {
		const lang = this._extToLang(filePath);
		if (!lang) {
			throw new Error(`Unsupported file extension for sg: ${filePath}`);
		}
		return this._spawnSg(["run", "--json=stream", "-p", pattern, "-l", lang, filePath], filePath, signal, limit);
	}

	async searchMany(
		rootDir: string,
		pattern: string,
		language: string,
		signal?: AbortSignal,
		limit?: number,
	): Promise<SearchResult> {
		return this._spawnSg(["run", "--json=stream", "-p", pattern, "-l", language, rootDir], rootDir, signal, limit);
	}

	async rewrite(filePath: string, pattern: string, replacement: string): Promise<string> {
		const lang = this._extToLang(filePath);
		if (!lang) {
			throw new Error(`Unsupported file extension for sg: ${filePath}`);
		}

		const sgPath = await this._getSgPath();
		return new Promise<string>((resolve, reject) => {
			const proc = spawn(sgPath, ["run", "-p", pattern, "-r", replacement, "-l", lang, filePath], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf-8");
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});

			const timeout = setTimeout(() => {
				proc.kill("SIGTERM");
				reject(new Error(`sg timed out after ${SG_SPAWN_TIMEOUT_MS}ms`));
			}, SG_SPAWN_TIMEOUT_MS);

			proc.on("close", (code) => {
				clearTimeout(timeout);
				if (code === 0) {
					resolve(stdout);
				} else {
					reject(new Error(stderr.trim() || `sg exited with code ${code}`));
				}
			});

			proc.on("error", (err) => {
				clearTimeout(timeout);
				reject(new Error(`Failed to spawn sg: ${err.message}`));
			});
		});
	}

	// ====================================================================
	// 内部 spawn + 流式解析
	// ====================================================================

	/**
	 * spawn `sg --json=stream`，流式解析 NDJSON，支持 AbortSignal 和 limit。
	 *
	 * - 监听 AbortSignal → kill 子进程
	 * - 达到 limit 时 kill 子进程，避免浪费 CPU/IO
	 * - 使用 `close` 事件（而非 `exit`）确保 stdout 完整读取
	 * - 返回 `killedDueToLimit` 标志，仅在子进程因超限被 kill 时为 true
	 */
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
			let killedDueToLimit = false;

			const stopChild = () => {
				if (!child.killed) {
					child.kill();
				}
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
				if (aborted) return;
				if (!line.trim()) return;

				// 当已收集到第 limit 条时，下一条才触发截断。
				// 这样恰好 limit 条且自然结束时 killedDueToLimit 为 false。
				if (limit !== undefined && matches.length >= limit) {
					killedDueToLimit = true;
					stopChild();
					return;
				}

				try {
					const obj = JSON.parse(line) as Record<string, unknown>;
					const matchFilePath = typeof obj.file === "string" ? obj.file : defaultFilePath;
					const match = this._parseMatchNode(obj, matchFilePath);
					if (match) matches.push(match);
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
