import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

// ============================================================================
// Config 类型
// ============================================================================

interface PixConfig {
	firecrawl?: { apiKey?: string };
	exa?: { apiKey?: string };
}

// ============================================================================
// 路径
// ============================================================================

/** pi agent 目录下的 pix 配置路径，与 pi core 共享同一配置目录体系 */
export function getPixConfigPath(): string {
	return join(getAgentDir(), "pix-config.json");
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
	if (errors.length > 0) {
		const e = errors[0];
		throw new Error(
			`Failed to parse ${configPath} at offset ${e.offset}: ${printParseErrorCode(e.error)}`,
		);
	}
	cachedConfig = result;
	return result;
}

// ============================================================================
// API Key 获取（env var 优先 → 配置文件回退 → 无则抛错）
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

function requireApiKey(
	providerKey: keyof PixConfig,
	envVar: string,
	label: string,
): string {
	const key = resolveApiKey(providerKey, envVar);
	if (key) return key;
	throw new Error(
		`${label} API key not found. Set ${envVar} environment variable ` +
			`or add '${providerKey}.apiKey' in ${getPixConfigPath()}.`,
	);
}

/** 检查 Firecrawl API Key 是否已配置（env 或 config 文件） */
export function hasFirecrawlApiKey(): boolean {
	return resolveApiKey("firecrawl", "FIRECRAWL_API_KEY") !== undefined;
}

/** 获取 Firecrawl API Key（无配置时抛错） */
export function getFirecrawlApiKey(): string {
	return requireApiKey("firecrawl", "FIRECRAWL_API_KEY", "Firecrawl");
}

/** 检查 Exa API Key 是否已配置 */
export function hasExaApiKey(): boolean {
	return resolveApiKey("exa", "EXA_API_KEY") !== undefined;
}

/** 获取 Exa API Key（无配置时抛错） */
export function getExaApiKey(): string {
	return requireApiKey("exa", "EXA_API_KEY", "Exa");
}
