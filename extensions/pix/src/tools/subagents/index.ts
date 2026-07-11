import callAgent from "./call-agent.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * subagents — call_agent 工具入口。
 *
 * 将任务委派给独立的子代理执行，返回自然语言结果。
 */
export default function subagents(pi: ExtensionAPI): void {
	callAgent(pi);
}
