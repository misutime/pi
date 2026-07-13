import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PATTERNS } from "../ast/patterns.ts";
import type { StructuralSearch } from "../ast/search.ts";
import type { PatternMatch } from "../ast/types.ts";
import type { LspClient } from "../lsp/client.ts";
import type { LspManager } from "../lsp/manager.ts";
import type { LspDiagnostic, ReferenceInfo, SymbolInfo, SymbolKind } from "./types.ts";

/**
 * 语义索引。
 *
 * 给 Agent tool 层提供统一、简洁的查询接口。屏蔽底层是 LSP 还是 sg CLI。
 *
 * 策略：LSP 优先 → sg CLI fallback → 空结果。
 */
export class SemanticIndex {
	private _lspManager: LspManager | null;
	private _search: StructuralSearch;
	/** 轻量符号缓存：filePath → symbols */
	private _symbolCache = new Map<string, SymbolInfo[]>();
	/** 已发送 didOpen 的文件 uri 集合 */
	private _openedFiles = new Set<string>();

	/**
	 * @param lspManager - LspManager 实例。null 时语义工具仅走 sg CLI fallback。
	 * @param search - sg CLI 结构化搜索，作为 fallback。
	 */
	constructor(lspManager: LspManager | null, search: StructuralSearch) {
		this._lspManager = lspManager;
		this._search = search;
	}

	/**
	 * 按文件路径获取对应语言的 LspClient（按需启动）。
	 * 无 LspManager 或语言不支持时返回 null。
	 */
	private async _getLspClient(filePath: string): Promise<LspClient | null> {
		if (!this._lspManager) return null;
		const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
		const lang = EXT_TO_LSP_LANG[ext];
		if (!lang) return null;
		return this._lspManager.getOrStart(lang);
	}

	/**
	 * 确保文件已发送 didOpen 通知给 LSP server。
	 * 每个文件首次 LSP 查询前调用一次。
	 */
	private async _ensureOpen(lsp: LspClient, filePath: string): Promise<void> {
		const uri = filePathToUri(filePath);
		if (this._openedFiles.has(uri)) return;
		try {
			const content = await readFile(filePath, "utf-8");
			const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
			const lang = EXT_TO_LSP_LANG[ext] ?? ext.slice(1);
			lsp.notifyDidOpen({
				textDocument: { uri, languageId: lang, version: 1, text: content },
			});
			this._openedFiles.add(uri);
		} catch {
			// File unreadable — skip didOpen. Server may still respond to queries.
		}
	}

	// ========================
	// 查询方法
	// ========================

	/**
	 * 在项目中按名称查找符号。
	 *
	 * 策略：LSP workspace/symbols → sg 搜索所有已知文件 → 按 name 过滤。
	 */
	async findSymbol(query: string, _kind?: SymbolKind): Promise<SymbolInfo[]> {
		// For MVP, search cached symbols by name.
		const results: SymbolInfo[] = [];
		for (const symbols of this._symbolCache.values()) {
			for (const sym of symbols) {
				if (sym.name.includes(query)) {
					results.push(sym);
				}
			}
		}
		return results;
	}

	/**
	 * 获取指定位置的符号的源代码定义位置。
	 *
	 * 策略：LSP definition → sg 分析 import + 搜索目标文件。
	 */
	async definition(filePath: string, line: number, column: number): Promise<SymbolInfo | null> {
		const lsp = await this._getLspClient(filePath);
		if (lsp) {
			try {
				await this._ensureOpen(lsp, filePath);
				const uri = filePathToUri(filePath);
				const result = await lsp.definition(uri, { line, character: column });
				if (result) {
					const loc = Array.isArray(result) ? result[0] : result;
					if (loc) return locationToSymbol(loc);
				}
			} catch {
				// LSP failed — fall through to sg fallback.
			}
		}

		// Fallback: sg search in current file for the symbol at position, then
		// try to find its definition via same-file search.
		return this._sgDefinition(filePath, line);
	}

	/**
	 * 查找所有对指定位置符号的引用。
	 *
	 * 策略：LSP references → grep + sg confirmation。
	 */
	async references(filePath: string, line: number, column: number): Promise<ReferenceInfo[]> {
		const lsp = await this._getLspClient(filePath);
		if (lsp) {
			try {
				await this._ensureOpen(lsp, filePath);
				const uri = filePathToUri(filePath);
				const locations = await lsp.references(uri, { line, character: column }, true);
				if (locations.length > 0) {
					return locations.map((loc) => ({
						symbol: locationToSymbol(loc),
						filePath: uriToFilePath(loc.uri),
						line: loc.range.start.line,
						column: loc.range.start.character,
						context: "",
					}));
				}
			} catch {
				// LSP failed — fall through to fallback.
			}
		}
		// Fallback: not implemented in MVP. Would need grep + sg confirmation.
		return [];
	}

	/**
	 * 获取光标位置符号的类型信息和文档。
	 *
	 * 策略：LSP hover → sg 结构上下文 + 注释提取。
	 */
	async hover(filePath: string, line: number, column: number): Promise<string | null> {
		const lsp = await this._getLspClient(filePath);
		if (lsp) {
			try {
				await this._ensureOpen(lsp, filePath);
				const uri = filePathToUri(filePath);
				const result = await lsp.hover(uri, { line, character: column });
				if (result) {
					return typeof result.contents === "string" ? result.contents : result.contents.value;
				}
			} catch {
				// LSP failed — fall through to fallback.
			}
		}
		// Fallback: not implemented in MVP.
		return null;
	}

	/**
	 * 获取文件的符号大纲。
	 *
	 * 策略：LSP documentSymbol → sg search functions/classes/variables。
	 */
	async outline(filePath: string): Promise<SymbolInfo[]> {
		const lsp = await this._getLspClient(filePath);
		if (lsp) {
			try {
				await this._ensureOpen(lsp, filePath);
				const uri = filePathToUri(filePath);
				const symbols = await lsp.documentSymbols(uri);
				if (symbols.length > 0) return flattenDocumentSymbols(symbols, filePath);
			} catch {
				// LSP failed — fall through to sg fallback.
			}
		}
		// Fallback: use sg to find functions and classes.
		return this._sgOutline(filePath);
	}

	/**
	 * 获取文件的诊断（错误、警告）。
	 *
	 * 策略：LSP only。sg 不做类型检查。
	 */
	async diagnostics(filePath: string): Promise<LspDiagnostic[]> {
		const lsp = await this._getLspClient(filePath);
		if (lsp) {
			try {
				await this._ensureOpen(lsp, filePath);
				const uri = filePathToUri(filePath);
				return lsp.diagnostics(uri);
			} catch {
				// LSP failed — no diagnostics available.
			}
		}
		return [];
	}

	// ========================
	// 结构化搜索
	// ========================

	/**
	 * 用代码模式搜索单个文件。直接透传 sg CLI。
	 *
	 * 用于 Agent 需要按结构搜索的场景，例如：
	 * - 找所有函数声明：`"function $NAME($$$) { $$$ }"`
	 * - 找所有类：`"class $NAME { $$$ }"`
	 * - 找所有 import：`"import { $$$ } from '$MODULE'"`
	 *
	 * 对比 grep：只匹配语法节点，不匹配注释、字符串中的同名文本。
	 */
	async search(filePath: string, pattern: string): Promise<PatternMatch[]> {
		return this._search.search(filePath, pattern);
	}

	/**
	 * 在目录中递归搜索，按 language 指定语言。
	 * 用于项目级结构搜索。
	 */
	async searchMany(rootDir: string, pattern: string, language: string): Promise<PatternMatch[]> {
		return this._search.searchMany(rootDir, pattern, language);
	}

	// ========================
	// 索引管理
	// ========================

	/**
	 * 关闭所有 LSP 连接和进程。AgentSession dispose 时调用。
	 */
	async shutdown(): Promise<void> {
		if (this._lspManager) {
			await this._lspManager.shutdown();
		}
	}

	/**
	 * 单个文件变更后增量更新索引。
	 *
	 * Agent 每次 edit 后调用，保持索引时效。
	 */
	async updateFile(filePath: string): Promise<void> {
		try {
			const symbols = await this._sgOutline(filePath);
			this._symbolCache.set(filePath, symbols);
		} catch {
			this._symbolCache.delete(filePath);
		}
	}

	// ========================
	// sg fallback 实现
	// ========================

	/**
	 * 用 sg 在单文件中查找符号定义（best effort）。
	 */
	private async _sgDefinition(filePath: string, _line: number): Promise<SymbolInfo | null> {
		// Simple approach: search for function/class declarations to build a symbol list.
		const symbols = await this._sgOutline(filePath);
		// Return only if we found exactly one function declaration.
		// (position-based matching would require column info from the caller.)
		return symbols.length === 1 ? symbols[0] : null;
	}

	/**
	 * 用 sg 提取文件的函数和类符号。
	 */
	private async _sgOutline(filePath: string): Promise<SymbolInfo[]> {
		const symbols: SymbolInfo[] = [];
		const patterns = getPatternsForFile(filePath);

		// Search for functions.
		for (const pat of patterns.functions ?? []) {
			try {
				const matches = await this._search.search(filePath, pat);
				for (const m of matches) {
					const name = m.captures.NAME ?? m.text.trim();
					symbols.push({
						name,
						kind: "function",
						location: { filePath, line: m.range.start.line, column: m.range.start.column },
						signature: m.text.trim(),
					});
				}
			} catch {
				// sg not available for this language.
			}
		}

		// Search for classes.
		for (const pat of patterns.classes ?? []) {
			try {
				const matches = await this._search.search(filePath, pat);
				for (const m of matches) {
					const name = m.captures.NAME ?? m.text.trim();
					if (name) {
						symbols.push({
							name,
							kind: "class",
							location: { filePath, line: m.range.start.line, column: m.range.start.column },
						});
					}
				}
			} catch {
				// sg not available.
			}
		}

		return symbols;
	}
}

// ============================================================================
// 常量
// ============================================================================

/** 文件扩展名 → LSP language 映射。 */
const EXT_TO_LSP_LANG: Record<string, string> = {
	".ts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "javascript",
	".py": "python",
	".rs": "rust",
	".go": "go",
};

// ============================================================================
// 工具函数
// ============================================================================

function filePathToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

function uriToFilePath(uri: string): string {
	return fileURLToPath(uri);
}

function locationToSymbol(loc: { uri: string; range: { start: { line: number; character: number } } }): SymbolInfo {
	return {
		name: "",
		kind: "unknown",
		location: {
			filePath: uriToFilePath(loc.uri),
			line: loc.range.start.line,
			column: loc.range.start.character,
		},
	};
}

function flattenDocumentSymbols(
	symbols: Array<{
		name: string;
		kind: number;
		range: { start: { line: number; character: number } };
		children?: unknown[];
	}>,
	filePath: string,
): SymbolInfo[] {
	const result: SymbolInfo[] = [];
	const stack = [...symbols];
	while (stack.length > 0) {
		const s = stack.pop()!;
		result.push({
			name: s.name,
			kind: lspKindToSymbolKind(s.kind),
			location: {
				filePath,
				line: s.range.start.line,
				column: s.range.start.character,
			},
		});
		const children = s.children as Array<typeof s> | undefined;
		if (children) {
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push(children[i]);
			}
		}
	}
	return result;
}

function lspKindToSymbolKind(kind: number): SymbolKind {
	// LSP SymbolKind values.
	switch (kind) {
		case 12:
			return "function";
		case 6:
			return "method";
		case 5:
			return "class";
		case 11:
			return "interface";
		case 13:
			return "variable";
		case 7:
			return "property" as SymbolKind;
		case 2:
			return "module";
		default:
			return "unknown";
	}
}

/**
 * 按文件扩展名获取对应的 pattern 集。
 */
function getPatternsForFile(filePath: string): { functions: string[]; classes: string[] } {
	const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	switch (ext) {
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
			return PATTERNS.javascript as unknown as { functions: string[]; classes: string[] };
		case ".py":
			return PATTERNS.python as unknown as { functions: string[]; classes: string[] };
		case ".rs":
			return PATTERNS.rust as unknown as { functions: string[]; classes: string[] };
		default:
			return { functions: [], classes: [] };
	}
}
