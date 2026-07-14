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
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "../truncate.ts";
import { StructuralSearch } from "./search.ts";
import type { PatternMatch } from "./types.ts";

const astSchema = Type.Object({
	pattern: Type.String({
		description:
			"Code pattern to search with. Use $NAME for identifiers, $$$ for any nodes. E.g. 'function $NAME($$$) { $$$ }' to match all function declarations.",
	}),
	path: Type.Optional(Type.String({ description: "File or directory to search in (default: current directory)" })),
	language: Type.Optional(
		Type.String({
			description:
				"Language identifier, e.g. typescript, python, rust. Auto-detected from file extension for single files; required for directory search.",
		}),
	),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Glob patterns to filter files, e.g. ['src/**/*.ts', '!**/*.test.ts']",
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
	truncation?: TruncationResult;
	linesTruncated?: boolean;
}

function formatAstCall(
	args: { pattern: string; path?: string; language?: string; globs?: string[]; limit?: number } | undefined,
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
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
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
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

function formatMatch(match: PatternMatch): { line: string; wasTruncated: boolean } {
	const filePath = match.filePath.replace(/\\/g, "/");
	const line = match.range.start.line;
	const text = match.text.replace(/\r?\n/g, " ").trim();
	const keys = Object.keys(match.captures);
	const lineText = keys.length > 0 ? `${text}  [${keys.map((k) => `${k}: ${match.captures[k]}`).join(", ")}]` : text;
	const { text: truncated, wasTruncated } = truncateLine(lineText);
	return { line: `${filePath}:${line}: ${truncated}`, wasTruncated };
}

export function createAstToolDefinition(
	cwd: string,
	_options?: AstToolOptions,
): ToolDefinition<typeof astSchema, AstToolDetails | undefined> {
	return {
		name: "ast",
		label: "ast",
		description: `Search code by AST pattern using ast-grep. Returns matching code blocks with file paths, line numbers, and captured variables. Supports JS/TS, Python, Rust, Go, Java, C/C++/C#, and more. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search code structure with AST patterns (ast-grep)",
		parameters: astSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchPath, language, globs, limit }: AstToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

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
					result = await search.searchMany(resolvedPath, pattern, language, {
						signal,
						limit: effectiveLimit,
						globs,
					});
				} else {
					result = await search.search(resolvedPath, pattern, {
						signal,
						limit: effectiveLimit,
						language,
						globs,
					});
				}
			} else {
				if (!language) {
					throw new Error(
						"language parameter is required when searching the whole project. E.g. language: 'typescript'",
					);
				}
				result = await search.searchMany(cwd, pattern, language, {
					signal,
					limit: effectiveLimit,
					globs,
				});
			}

			const { matches, killedDueToLimit } = result;

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: undefined,
				};
			}

			// Format output with per-line truncation, then apply byte truncation.
			let linesTruncated = false;
			const formattedLines: string[] = [];
			for (const m of matches) {
				const fm = formatMatch(m);
				if (fm.wasTruncated) linesTruncated = true;
				formattedLines.push(fm.line);
			}
			const rawOutput = formattedLines.join("\n");

			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;

			const details: AstToolDetails = {};
			const notices: string[] = [];
			if (killedDueToLimit) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

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
