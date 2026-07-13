import { Type } from "typebox";
import type { PatternMatch } from "../ast/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SemanticIndex } from "../semantic/semantic-index.ts";

// ============================================================================
// Schema definitions
// ============================================================================

const positionSchema = Type.Object({
	filePath: Type.String({ description: "Relative or absolute file path" }),
	line: Type.Number({ description: "0-based line number" }),
	column: Type.Number({ description: "0-based character offset" }),
});

const fileSchema = Type.Object({
	filePath: Type.String({ description: "Relative or absolute file path" }),
});

const querySchema = Type.Object({
	query: Type.String({ description: "Symbol name to search for" }),
});

const searchPatternSchema = Type.Object({
	pattern: Type.String({
		description:
			"Code pattern to search for. Use $NAME for identifiers, $$$ for any nodes. E.g. 'function $NAME($$$) { $$$ }' matches all function declarations",
	}),
	path: Type.Optional(Type.String({ description: "File or directory to search in (default: current directory)" })),
	language: Type.Optional(
		Type.String({
			description:
				"Language identifier, e.g. typescript, python, rust. Auto-detected from file extension if omitted.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum results (default: 100)" })),
});

// ============================================================================
// Tool detail types
// ============================================================================

export interface GoToDefinitionDetails {
	filePath: string;
	line: number;
	column: number;
	signature?: string;
}

export interface FindReferencesDetails {
	locations: Array<{ filePath: string; line: number; column: number }>;
}

export interface SymbolHoverDetails {
	text: string;
}

export interface FileSymbolsDetails {
	symbols: Array<{ name: string; kind: string; line: number; column: number }>;
}

export interface WorkspaceSymbolsDetails {
	symbols: Array<{ name: string; kind: string; filePath: string; line: number; column: number }>;
}

export interface DiagnosticsDetails {
	diagnostics: Array<{ line: number; column: number; severity: string; message: string }>;
}

// ============================================================================
// Tool definitions
// ============================================================================

interface SemanticToolOptions {
	semanticIndex: SemanticIndex;
}

export function createSemanticToolDefinitions(opts: SemanticToolOptions): ToolDefinition[] {
	const si = opts.semanticIndex;

	return [
		createGoToDefinitionTool(si),
		createFindReferencesTool(si),
		createSymbolHoverTool(si),
		createFileSymbolsTool(si),
		createWorkspaceSymbolsTool(si),
		createDiagnosticsTool(si),
		createSearchPatternTool(si),
	];
}

function createGoToDefinitionTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "go_to_definition",
		label: "Go To Definition",
		description: "Jump to the definition of a symbol at a given position in a file.",
		parameters: positionSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { filePath, line, column } = params as { filePath: string; line: number; column: number };
			const result = await si.definition(filePath, line, column);
			if (!result) {
				return { content: [{ type: "text", text: "No definition found." }], details: null };
			}
			const details: GoToDefinitionDetails = {
				filePath: result.location.filePath,
				line: result.location.line,
				column: result.location.column,
				signature: result.signature,
			};
			return {
				content: [
					{
						type: "text",
						text: `${result.name} defined at ${result.location.filePath}:${result.location.line + 1}:${result.location.column + 1}`,
					},
				],
				details,
			};
		},
	};
}

function createFindReferencesTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "find_references",
		label: "Find References",
		description: "Find all references to a symbol at a given position.",
		parameters: positionSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { filePath, line, column } = params as { filePath: string; line: number; column: number };
			const refs = await si.references(filePath, line, column);
			const details: FindReferencesDetails = {
				locations: refs.map((r) => ({ filePath: r.filePath, line: r.line, column: r.column })),
			};
			const text =
				refs.length === 0
					? "No references found."
					: refs.map((r) => `${r.filePath}:${r.line + 1}:${r.column + 1}`).join("\n");
			return { content: [{ type: "text", text }], details };
		},
	};
}

function createSymbolHoverTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "symbol_hover",
		label: "Symbol Hover",
		description: "Get type information and documentation for a symbol at a given position.",
		parameters: positionSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { filePath, line, column } = params as { filePath: string; line: number; column: number };
			const result = await si.hover(filePath, line, column);
			const text = result ?? "No information available.";
			return { content: [{ type: "text", text }], details: { text } as SymbolHoverDetails };
		},
	};
}

function createFileSymbolsTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "file_symbols",
		label: "File Symbols",
		description: "List all symbols (functions, classes, variables) in a file.",
		parameters: fileSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { filePath } = params as { filePath: string };
			const symbols = await si.outline(filePath);
			const details: FileSymbolsDetails = {
				symbols: symbols.map((s) => ({
					name: s.name,
					kind: s.kind,
					line: s.location.line,
					column: s.location.column,
				})),
			};
			const text =
				symbols.length === 0
					? "No symbols found."
					: symbols.map((s) => `${s.kind}\t${s.name}\tline ${s.location.line + 1}`).join("\n");
			return { content: [{ type: "text", text }], details };
		},
	};
}

function createWorkspaceSymbolsTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "workspace_symbols",
		label: "Workspace Symbols",
		description: "Search for symbols by name across the workspace.",
		parameters: querySchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query } = params as { query: string };
			const symbols = await si.findSymbol(query);
			const details: WorkspaceSymbolsDetails = {
				symbols: symbols.map((s) => ({
					name: s.name,
					kind: s.kind,
					filePath: s.location.filePath,
					line: s.location.line,
					column: s.location.column,
				})),
			};
			const text =
				symbols.length === 0
					? "No symbols found."
					: symbols.map((s) => `${s.kind}\t${s.name}\t${s.location.filePath}:${s.location.line + 1}`).join("\n");
			return { content: [{ type: "text", text }], details };
		},
	};
}

function createDiagnosticsTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "diagnostics",
		label: "Diagnostics",
		description: "Get compiler/linter diagnostics (errors, warnings, hints) for a file.",
		parameters: fileSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { filePath } = params as { filePath: string };
			const diags = await si.diagnostics(filePath);
			const details: DiagnosticsDetails = {
				diagnostics: diags.map((d) => ({
					line: d.range.start.line,
					column: d.range.start.character,
					severity: severityLabel(d.severity),
					message: d.message,
				})),
			};
			const text =
				diags.length === 0
					? "No diagnostics."
					: diags
							.map((d) => `${severityLabel(d.severity)} line ${d.range.start.line + 1}: ${d.message}`)
							.join("\n");
			return { content: [{ type: "text", text }], details };
		},
	};
}

function createSearchPatternTool(si: SemanticIndex): ToolDefinition {
	return {
		name: "search_pattern",
		label: "Search Pattern",
		description:
			"Search code by structural pattern (AST-aware). Matches syntax nodes, not plain text. Use $NAME for identifiers, $$$ for any nodes. E.g. 'function $NAME($$$) { $$$ }' finds all function declarations.",
		parameters: searchPatternSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { pattern, path, language } = params as {
				pattern: string;
				path?: string;
				language?: string;
				limit?: number;
			};
			const filePath = path ?? ".";
			let matches: PatternMatch[];

			// 文件路径（含扩展名）→ 单文件搜索；目录路径 → 需要指定 language
			const isFile = /\.\w+$/.test(filePath);
			if (isFile) {
				matches = await si.search(filePath, pattern);
			} else if (language) {
				matches = await si.searchMany(filePath, pattern, language);
			} else {
				return {
					content: [
						{
							type: "text",
							text: "For directory search, please specify the --language parameter (e.g. --language typescript).",
						},
					],
					details: {},
				};
			}
			const details = {
				matches: matches.map((m) => ({
					filePath: m.filePath,
					line: m.range.start.line,
					text: m.text,
					captures: m.captures,
				})),
			};
			const text =
				matches.length === 0
					? "No matches found."
					: matches.map((m) => `${m.filePath}:${m.range.start.line + 1}  ${m.text.trim()}`).join("\n");
			return { content: [{ type: "text", text }], details };
		},
	};
}

function severityLabel(severity?: number): string {
	switch (severity) {
		case 1:
			return "Error";
		case 2:
			return "Warning";
		case 3:
			return "Info";
		case 4:
			return "Hint";
		default:
			return "";
	}
}
