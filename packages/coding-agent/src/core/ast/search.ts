import { spawn } from "node:child_process";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { PatternMatch, Position } from "./types.ts";

const SG_SPAWN_TIMEOUT_MS = 15_000;

/**
 * 通过 spawn `sg` CLI 进行结构化代码搜索与重写。
 *
 * `sg` 二进制由 `tools-manager.ts` 管理（与 fd/rg 同模式），
 * 首次使用时从 GitHub Releases 自动下载平台二进制。
 */
export class StructuralSearch {
	/**
	 * 确保 sg 二进制可用。
	 * 调用 ensureTool("sg") → 已缓存直接返回路径，否则下载。
	 */
	private async _getSgPath(): Promise<string> {
		const path = await ensureTool("sg");
		if (!path) {
			throw new Error("sg binary not available. Install ast-grep or ensure network access for auto-download.");
		}
		return path;
	}

	/**
	 * 按文件扩展名映射到 sg --lang 参数。
	 * .ts → typescript, .rs → rust, .py → python, .go → go, etc.
	 */
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

	/**
	 * 用代码模式搜索文件。
	 *
	 * 内部：spawn("sg", ["run", "--json", "-p", pattern, "-l", lang, filePath])
	 *       解析 stdout JSON → PatternMatch[]
	 *
	 * 模式语法：
	 *   `$NAME`  → 捕获单个标识符
	 *   `$$$`    → 捕获零个或多个任意节点
	 */
	async search(filePath: string, pattern: string): Promise<PatternMatch[]> {
		const lang = this._extToLang(filePath);
		if (!lang) {
			throw new Error(`Unsupported file extension for sg: ${filePath}`);
		}

		const { stdout } = await this._spawnSg(["run", "--json=stream", "-p", pattern, "-l", lang, filePath]);
		return this._parseSearchOutput(stdout, filePath);
	}

	/**
	 * 在目录中递归搜索。
	 *
	 * 内部：spawn("sg", ["run", "--json", "-p", pattern, "-l", lang, rootDir])
	 */
	async searchMany(rootDir: string, pattern: string, language: string): Promise<PatternMatch[]> {
		const { stdout } = await this._spawnSg(["run", "--json=stream", "-p", pattern, "-l", language, rootDir]);
		return this._parseSearchOutput(stdout, rootDir);
	}

	/**
	 * 代码重写：将匹配到的 pattern 替换为 replacement。
	 *
	 * 注意：返回值等实现时验证 CLI 行为后决定。
	 *       RewriteResult shape TBD after CLI verification.
	 */
	async rewrite(filePath: string, pattern: string, replacement: string): Promise<unknown> {
		const lang = this._extToLang(filePath);
		if (!lang) {
			throw new Error(`Unsupported file extension for sg: ${filePath}`);
		}

		const { stdout } = await this._spawnSg(["run", "-p", pattern, "-r", replacement, "-l", lang, filePath]);
		return stdout;
	}

	// ====================================================================
	// 内部 spawn 封装
	// ====================================================================

	/**
	 * 内部 spawn `sg`，处理超时、错误、stderr、非零退出码。
	 */
	private async _spawnSg(args: string[]): Promise<{ stdout: string; stderr: string }> {
		const sgPath = await this._getSgPath();

		return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
			const proc = spawn(sgPath, args, {
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

			proc.on("exit", (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					const msg = stderr.trim() || `sg exited with code ${code} signal ${signal}`;
					reject(new Error(msg));
				}
			});

			proc.on("error", (err) => {
				clearTimeout(timeout);
				reject(new Error(`Failed to spawn sg: ${err.message}`));
			});
		});
	}

	/**
	 * 解析 sg --json 输出为 PatternMatch[]。
	 */
	private _parseSearchOutput(stdout: string, filePath: string): PatternMatch[] {
		if (!stdout.trim()) return [];

		const results: PatternMatch[] = [];
		// sg --json 输出为每行一个 JSON 对象 (NDJSON)。
		for (const line of stdout.trim().split("\n")) {
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				// Use the file path from sg output when available (directory search),
				// otherwise fall back to the default file path (single-file search).
				const matchFilePath = typeof obj.file === "string" ? obj.file : filePath;
				const match = this._parseMatchNode(obj, matchFilePath);
				if (match) results.push(match);
			} catch {
				// Skip unparseable lines.
			}
		}
		return results;
	}

	/**
	 * 从 sg JSON 输出中提取单个匹配项。
	 *
	 * sg CLI JSON 格式（简化）：
	 * {
	 *   "file": "path/to/file",
	 *   "range": { "start": {...}, "end": {...} },
	 *   "text": "matched text",
	 *   "metaVariables": { "single": { "NAME": { "text": "login" } }, "multi": {...} }
	 * }
	 */
	private _parseMatchNode(obj: Record<string, unknown>, filePath: string): PatternMatch | null {
		const range = obj.range as Record<string, Record<string, number>> | undefined;
		const text = typeof obj.text === "string" ? obj.text : "";
		const metaVariables = obj.metaVariables as Record<string, Record<string, { text: string }>> | undefined;

		if (!range?.start || !range?.end) return null;

		const start = range.start;
		const end = range.end;
		const startPos: Position = { line: start.line, column: start.column };
		const endPos: Position = { line: end.line, column: end.column };

		const captures: Record<string, string> = {};
		if (metaVariables?.single) {
			for (const [name, val] of Object.entries(metaVariables.single)) {
				if (val && typeof val.text === "string") {
					captures[name] = val.text;
				}
			}
		}
		if (metaVariables?.multi) {
			for (const [name, val] of Object.entries(metaVariables.multi)) {
				if (val && typeof val.text === "string") {
					captures[name] = val.text;
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
