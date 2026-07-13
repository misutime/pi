/** LSP 基础类型。按需添加，仅列 MVP 核心类型。 */

// ============================================================================
// 位置与范围
// ============================================================================

/** 文档位置（0-based）。 */
export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

// ============================================================================
// 文档标识
// ============================================================================

export interface LspTextDocumentIdentifier {
	uri: string;
}

export interface LspVersionedTextDocumentIdentifier extends LspTextDocumentIdentifier {
	version: number;
}

// ============================================================================
// Initialize
// ============================================================================

export interface LspInitializeParams {
	processId: number;
	rootUri: string;
	capabilities: Record<string, unknown>;
}

export interface LspInitializeResult {
	capabilities: Record<string, unknown>;
	serverInfo?: { name: string; version?: string };
}

// ============================================================================
// 文档同步
// ============================================================================

export interface LspDidOpenParams {
	textDocument: {
		uri: string;
		languageId: string;
		version: number;
		text: string;
	};
}

export interface LspDidChangeParams {
	textDocument: LspVersionedTextDocumentIdentifier;
	contentChanges: Array<{
		text: string;
		range?: LspRange;
	}>;
}

// ============================================================================
// 核心查询
// ============================================================================

export interface LspReferenceContext {
	includeDeclaration: boolean;
}

export interface LspReferenceParams {
	textDocument: LspTextDocumentIdentifier;
	position: LspPosition;
	context: LspReferenceContext;
}

export type LspDefinitionResult = LspLocation | LspLocation[] | null;

export type LspHoverContents = { kind: string; value: string } | string;

export interface LspHover {
	contents: LspHoverContents;
	range?: LspRange;
}

export interface LspDocumentSymbol {
	name: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: LspDocumentSymbol[];
}

// ============================================================================
// Diagnostics
// ============================================================================

/** 诊断严重程度：1=Error, 2=Warning, 3=Information, 4=Hint。 */
export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	message: string;
	source?: string;
}

export interface LspPublishDiagnosticsParams {
	uri: string;
	diagnostics: LspDiagnostic[];
}
