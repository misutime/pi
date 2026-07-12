import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, stripComments } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

// ============================================================================
// Config 类型
// ============================================================================

interface PixConfig {
	firecrawl?: { apiKey?: string };
	exa?: { apiKey?: string };
	gemini?: { apiKey?: string; searchModel?: string };
	jina?: { apiKey?: string };
}

// ============================================================================
// 路径
// ============================================================================

/** pi agent 目录下的 pix 配置路径，与 pi core 共享同一配置目录体系 */
export function getPixConfigPath(): string {
	return join(getAgentDir(), "pix-config.jsonc");
}

// ============================================================================
// 全局加载（懒 + 缓存）
// ============================================================================

let cachedConfig: PixConfig | undefined;

export function loadConfig(): PixConfig {
	if (cachedConfig !== undefined) return cachedConfig;

	const configPath = getPixConfigPath();
	if (!existsSync(configPath)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(configPath, "utf-8");
	const errors: ParseError[] = [];
	const result = parse(raw, errors) as PixConfig;

	// jsonc-parser 遇到尾逗号等 JSONC 特性会记录非致命错误但依然成功解析。
	// 去掉注释后，再移除尾逗号（JSONC 合法但标准 JSON 不合法），
	// 然后尝试 JSON.parse。通过则只有 JSONC 特性差异；失败则是真正的语法错误。
	const stripped = stripComments(raw).replace(/,(\s*[}\]])/g, "$1");
	try {
		JSON.parse(stripped);
	} catch {
		const e = errors[0];
		throw new Error(
			`Failed to parse ${configPath}${e ? ` at offset ${e.offset}: ${printParseErrorCode(e.error)}` : ""}`,
		);
	}

	cachedConfig = result;
	return result;
}

// ============================================================================
// API Key 获取（env var 优先 → 配置文件回退 → 无则返回 undefined）
// ============================================================================

function resolveApiKey(
	providerKey: keyof PixConfig,
	envVar: string,
): string | undefined {
	// 1. 环境变量（最高优先级）
	const env = process.env[envVar]?.trim();
	if (env) return env;

	// 2. 配置文件
	const config = loadConfig();
	const providerConfig = config[providerKey];
	if (providerConfig && typeof providerConfig === "object") {
		const key = (providerConfig as Record<string, unknown>).apiKey;
		if (typeof key === "string" && key.trim()) return key.trim();
	}

	return undefined;
}

/** 检查 Firecrawl API Key 是否已配置（env 或 config 文件） */
export function hasFirecrawlApiKey(): boolean {
	return resolveApiKey("firecrawl", "FIRECRAWL_API_KEY") !== undefined;
}

/** 获取 Firecrawl API Key（未配置时返回 undefined） */
export function getFirecrawlApiKey(): string | undefined {
	return resolveApiKey("firecrawl", "FIRECRAWL_API_KEY");
}

/** 检查 Exa API Key 是否已配置 */
export function hasExaApiKey(): boolean {
	return resolveApiKey("exa", "EXA_API_KEY") !== undefined;
}

/** 获取 Exa API Key（未配置时返回 undefined） */
export function getExaApiKey(): string | undefined {
	return resolveApiKey("exa", "EXA_API_KEY");
}

/** 检查 Gemini API Key 是否已配置 */
export function hasGeminiApiKey(): boolean {
	return resolveApiKey("gemini", "GEMINI_API_KEY") !== undefined;
}

/** 获取 Gemini API Key（未配置时返回 undefined） */
export function getGeminiApiKey(): string | undefined {
	return resolveApiKey("gemini", "GEMINI_API_KEY");
}

/** 检查 Jina API Key 是否已配置 */
export function hasJinaApiKey(): boolean {
	return resolveApiKey("jina", "JINA_API_KEY") !== undefined;
}

/** 获取 Jina API Key（未配置时返回 undefined） */
export function getJinaApiKey(): string | undefined {
	return resolveApiKey("jina", "JINA_API_KEY");
}
