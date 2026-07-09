import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "fs/promises";
import { dirname, join } from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

/**
 * Verify the write actually landed on the local filesystem.
 * Uses fs.stat for the fast path (microseconds); only reads content
 * when the size check fails and we need diagnostic details.
 *
 * Only called when using the default local WriteOperations.
 * Custom operations (e.g. SSH) are responsible for their own verification.
 */
async function verifyWrite(absolutePath: string, expected: string): Promise<void> {
	const expectedBytes = Buffer.byteLength(expected, "utf8");
	let stat: Awaited<ReturnType<typeof fsStat>>;
	try {
		stat = await fsStat(absolutePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const hint = buildWriteFailureHint(absolutePath, code);
		throw new Error(
			`Write reported success (${expectedBytes} bytes), but stat failed.
  path: ${absolutePath}
  error: ${code ?? String(error)}
${hint}`,
			{ cause: error },
		);
	}

	if (stat.size !== expectedBytes) {
		// Size mismatch — read back actual content for diagnostics.
		let actual: string;
		try {
			actual = await fsReadFile(absolutePath, "utf-8");
		} catch {
			actual = `(read failed after stat succeeded: ${stat.size} bytes on disk vs ${expectedBytes} expected)`;
		}
		const hint = buildWriteFailureHint(absolutePath);
		throw new Error(
			`Write reported success (${expectedBytes} bytes), but file size on disk is ${stat.size} bytes.
  path: ${absolutePath}
  actual content: ${actual.slice(0, 200)}${actual.length > 200 ? "..." : ""}
${hint}`,
		);
	}
}

/**
 * Build diagnostic hints for a failed write verification.
 * On Windows, include the VirtualStore path when the target is in a
 * protected directory that triggers filesystem redirection.
 */
function buildWriteFailureHint(absolutePath: string, errCode?: string): string {
	if (process.platform !== "win32") {
		return errCode === "ENOENT"
			? "The file was not found after a successful write. This may indicate a filesystem issue."
			: "";
	}

	const virtualStorePath = getVirtualStorePath(absolutePath);
	if (!virtualStorePath) {
		return errCode === "ENOENT"
			? "On Windows, this can be caused by antivirus software deleting or quarantining the file, or by cloud-sync conflicts (OneDrive, Dropbox)."
			: "On Windows, this can be caused by antivirus interference or cloud-sync conflicts (OneDrive, Dropbox).";
	}

	return `On Windows, ${absolutePath} is in a protected directory that triggers
filesystem redirection (VirtualStore). The file was likely written to:
  ${virtualStorePath}

To write to protected directories, run pi as Administrator.
Otherwise, write to a non-protected location (e.g. %USERPROFILE%).`;
}

/**
 * Return the VirtualStore path for a given absolute path on Windows.
 * Returns undefined if the path is not in a protected directory.
 *
 * Protected directories that trigger VirtualStore redirection:
 * - %ProgramFiles% (C:\Program Files, C:\Program Files (x86))
 * - %SystemRoot% (C:\Windows)
 */
function getVirtualStorePath(absolutePath: string): string | undefined {
	const lower = absolutePath.toLowerCase();
	const programFiles = (process.env.ProgramFiles ?? "C:\\Program Files").toLowerCase();
	const programFilesX86 = (process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)").toLowerCase();
	const systemRoot = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();

	const isProtected =
		lower === programFiles ||
		lower.startsWith(`${programFiles}\\`) ||
		lower === programFilesX86 ||
		lower.startsWith(`${programFilesX86}\\`) ||
		lower === systemRoot ||
		lower.startsWith(`${systemRoot}\\`);
	if (!isProtected) return undefined;

	// Strip only the drive root (e.g. "C:\") so the protected directory name
	// is included in the VirtualStore path. Windows redirects:
	//   C:\Program Files\MyApp\foo → %LOCALAPPDATA%\VirtualStore\Program Files\MyApp\foo
	const driveRootEnd = absolutePath.indexOf(":") + 2; // "C:\"
	const relativePath = absolutePath.slice(driveRootEnd).replace(/^[\\/]+/, "");
	const localAppData =
		process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
	return join(localAppData, "VirtualStore", relativePath);
}

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			const contentBytes = Buffer.byteLength(content, "utf8");
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				// Verify the write actually landed on the local filesystem.
				// Only valid for default local operations; custom ops (e.g. SSH)
				// are responsible for their own verification.
				if (ops === defaultWriteOperations) {
					await verifyWrite(absolutePath, content);
				}

				return {
					content: [{ type: "text", text: `Successfully wrote ${contentBytes} bytes to ${absolutePath}` }],
					details: undefined,
				};
			});
		},
		renderCall(args, theme, context) {
			const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
			const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
