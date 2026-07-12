import { loadExtensionConfig } from "@pi/extensions-shared/config";

// ============================================================================
// API Key 获取（env var 优先 → extensions.toml 回退 → 无则 undefined）
// ============================================================================

function resolveApiKey(
	providerKey: string,
	envVar: string,
): string | undefined {
	// 1. 环境变量（最高优先级）
	const env = process.env[envVar]?.trim();
	if (env) return env;

	// 2. extensions.toml [webtools.<key>].apiKey
	const config = loadExtensionConfig("webtools");
	const section = config[providerKey];
	if (section && typeof section === "object") {
		const key = (section as Record<string, unknown>).apiKey;
		if (typeof key === "string" && key.trim()) return key.trim();
	}

	return undefined;
}

/** 暴露 webtools 配置，供 gemini 读取 searchModel */
export function loadConfig(): Record<string, unknown> {
	return loadExtensionConfig("webtools");
}

/** 检查 Firecrawl API Key 是否已配置 */
export function hasFirecrawlApiKey(): boolean {
	return resolveApiKey("firecrawl", "FIRECRAWL_API_KEY") !== undefined;
}

/** 获取 Firecrawl API Key */
export function getFirecrawlApiKey(): string | undefined {
	return resolveApiKey("firecrawl", "FIRECRAWL_API_KEY");
}

/** 检查 Exa API Key 是否已配置 */
export function hasExaApiKey(): boolean {
	return resolveApiKey("exa", "EXA_API_KEY") !== undefined;
}

/** 获取 Exa API Key */
export function getExaApiKey(): string | undefined {
	return resolveApiKey("exa", "EXA_API_KEY");
}

/** 检查 Gemini API Key 是否已配置 */
export function hasGeminiApiKey(): boolean {
	return resolveApiKey("gemini", "GEMINI_API_KEY") !== undefined;
}

/** 获取 Gemini API Key */
export function getGeminiApiKey(): string | undefined {
	return resolveApiKey("gemini", "GEMINI_API_KEY");
}

/** 检查 Jina API Key 是否已配置 */
export function hasJinaApiKey(): boolean {
	return resolveApiKey("jina", "JINA_API_KEY") !== undefined;
}

/** 获取 Jina API Key */
export function getJinaApiKey(): string | undefined {
	return resolveApiKey("jina", "JINA_API_KEY");
}
