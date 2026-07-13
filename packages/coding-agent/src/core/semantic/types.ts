/** SemanticIndex 类型定义。 */

import type { LspDiagnostic } from "../lsp/types.ts";

/** 符号信息。 */
export interface SymbolInfo {
	name: string;
	kind: SymbolKind;
	location: {
		filePath: string;
		line: number;
		column: number;
	};
	/** 如果是函数/方法，包含签名信息。 */
	signature?: string;
	/** 所属类/模块。 */
	containerName?: string;
}

export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "variable"
	| "parameter"
	| "import"
	| "export"
	| "module"
	| "unknown";

/** 引用信息。 */
export interface ReferenceInfo {
	symbol: SymbolInfo;
	filePath: string;
	line: number;
	column: number;
	/** 引用的上下文文本（前后各一行）。 */
	context: string;
}

export type { LspDiagnostic };
