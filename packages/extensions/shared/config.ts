import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "smol-toml";

/**
 * 内置扩展共享配置加载器。
 *
 * 读取 ~/.pi/agent/extensions.toml（TOML 格式，支持注释）。
 * 每个扩展调用 loadExtensionConfig("webtools") 获取自己的命名空间。
 */

const CONFIG_PATH = join(getAgentDir(), "extensions.toml");

let cachedRaw: Record<string, unknown> | undefined;

function loadRaw(): Record<string, unknown> {
	if (cachedRaw !== undefined) return cachedRaw;

	if (!existsSync(CONFIG_PATH)) {
		cachedRaw = {};
		return cachedRaw;
	}

	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		cachedRaw = (parse(raw) as Record<string, unknown>) ?? {};
		return cachedRaw;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${msg}`);
	}
}

/** 获取指定扩展的配置命名空间 */
export function loadExtensionConfig(name: string): Record<string, unknown> {
	const all = loadRaw();
	return (all[name] as Record<string, unknown>) ?? {};
}
