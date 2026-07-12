import websearch from "./search.ts";
import webfetch from "./fetch.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * webtools — websearch + webfetch，pi 内置扩展。
 *
 * 在 extensions.toml 或环境变量中配置至少一个 provider 的 API key 即可使用。
 */
export default function webtools(pi: ExtensionAPI): void {
	websearch(pi);
	webfetch(pi);
}
