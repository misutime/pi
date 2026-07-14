import { stat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { resolveToCwd } from "../path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { StructuralSearch } from "./search.ts";
import type { PatternMatch } from "./types.ts";

const astSchema = Type.Object({
	pattern: Type.String({
		description:
			"Code pattern to search with. Use $NAME for identifiers, $$$ for any nodes. E.g. 'function $NAME($$$) { $$$ }' to match all function declarations.",
	}),
	path: Type.Optional(
		Type.String({
			description: "File or directory to search in (default: current directory)",
		}),
	),
	language: Type.Optional(
		Type.String({
			description:
				"Language identifier, e.g. typescript, python, rust. Auto-detected from file extension if omitted.",
		}),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum results (default: 100)" })),
});

export type AstToolInput = Static<typeof astSchema>;
const DEFAULT_LIMIT = 100;

export interface AstToolOptions {
	/** Reserved for future pluggable operations (e.g. remote search). */
}

export interface AstToolDetails {
	matchLimitReached?: number;
}

function formatAstCall(
	args: { pattern: string; path?: string; language?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const language = str(args?.language);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("ast")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `\`${pattern || ""}\``)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (language) text += theme.fg("toolOutput", ` (${language})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatAstResult(
	result: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		details?: AstToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	if (matchLimit) {
		text += `\n${theme.fg("warning", `[${matchLimit} results limit reached. Use limit=${matchLimit * 2} for more, or refine pattern]`)}`;
	}
	return text;
}

function formatMatch(match: PatternMatch): string {
	const filePath = match.filePath.replace(/\\/g, "/");
	const line = match.range.start.line;
	const text = match.text.replace(/\r?\n/g, " ").trim();
	const keys = Object.keys(match.captures);
	if (keys.length > 0) {
		const kv = keys.map((k) => `${k}: ${match.captures[k]}`).join(", ");
		return `${filePath}:${line}: ${text}  [${kv}]`;
	}
	return `${filePath}:${line}: ${text}`;
}

export function createAstToolDefinition(
	cwd: string,
	_options?: AstToolOptions,
): ToolDefinition<typeof astSchema, AstToolDetails | undefined> {
	return {
		name: "ast",
		label: "ast",
		description: `Search code by AST pattern using ast-grep. Returns matching code blocks with file paths, line numbers, and captured variables. Supports JS/TS, Python, Rust, Go, Java, C/C++/C#, and more. Output is truncated to ${DEFAULT_LIMIT} results.`,
		promptSnippet: "Search code structure with AST patterns (ast-grep)",
		parameters: astSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchPath, language, limit }: AstToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Runtime guard: truncate to integer (Type.Integer validates schema but
			// doesn't prevent runtime float).
			const effectiveLimit = limit !== undefined ? Math.max(1, Math.trunc(limit)) : DEFAULT_LIMIT;

			const search = new StructuralSearch();

			let result: { matches: PatternMatch[]; killedDueToLimit: boolean };
			if (searchPath) {
				const resolvedPath = resolveToCwd(searchPath, cwd);
				let isDirectory: boolean;
				try {
					const s = await stat(resolvedPath);
					isDirectory = s.isDirectory();
				} catch {
					throw new Error(`Path not found: ${resolvedPath}`);
				}

				if (isDirectory) {
					if (!language) {
						throw new Error("language parameter is required for directory search. E.g. language: 'typescript'");
					}
					result = await search.searchMany(resolvedPath, pattern, language, signal, effectiveLimit);
				} else {
					result = await search.search(resolvedPath, pattern, signal, effectiveLimit);
				}
			} else {
				if (!language) {
					throw new Error(
						"language parameter is required when searching the whole project. E.g. language: 'typescript'",
					);
				}
				result = await search.searchMany(cwd, pattern, language, signal, effectiveLimit);
			}

			const { matches, killedDueToLimit } = result;

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: undefined,
				};
			}

			const output = matches.map(formatMatch).join("\n");

			const details: AstToolDetails = {};
			if (killedDueToLimit) {
				details.matchLimitReached = effectiveLimit;
			}
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAstCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAstResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createAstTool(cwd: string, options?: AstToolOptions): AgentTool<typeof astSchema> {
	return wrapToolDefinition(createAstToolDefinition(cwd, options));
}
