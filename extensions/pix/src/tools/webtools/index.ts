import websearch from "./search.ts";
import webfetch from "./fetch.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * webtools — websearch + webfetch 统一入口。
 *
 * 只需在 pix-config.jsonc 中配置至少一个 provider 的 API key，
 * pi 加载此文件后两个工具均可用。
 */
export default function webtools(pi: ExtensionAPI): void {
	websearch(pi);
	webfetch(pi);
}
