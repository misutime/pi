/**
 * Subagent executor — creates child sessions and runs subagent tasks.
 */

import type { ThinkingLevel, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { IAgentConfig } from "./types.ts";
import {
  buildSubagentSystemPrompt,
  buildSubagentUserPrompt,
} from "./prompt.ts";
import { SubagentAbortScope } from "./abort-scope.ts";

// ============================================================================
// Types
// ============================================================================

export interface SubagentRunOptions {
  agent: IAgentConfig;
  task: string;
  cwd: string;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
  /** Model to use when the agent config does not specify one. */
  fallbackModel?: Model<any>;
  /** 总超时（毫秒）。超时后自动中止子代理并返回终止消息。 */
  timeoutMs?: number;
  /** 最大对话轮数（assistant message 计数）。超出后自动中止子代理。 */
  maxTurns?: number;
}

// ============================================================================
// Executor
// ============================================================================

export async function runSubagent(options: SubagentRunOptions): Promise<string> {
  const { agent, task, cwd, modelRegistry, signal, fallbackModel, timeoutMs, maxTurns } = options;

  // --- Build prompts ---
  const systemPrompt = buildSubagentSystemPrompt(agent);
  const userPrompt = buildSubagentUserPrompt(agent, task);

  // --- Resolve model ---
  let model: Model<any> | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  const resolved = resolveCliModel({ cliModel: agent.model, modelRegistry });

  if (resolved.error || !resolved.model) {
    if (fallbackModel) {
      console.error(
        `pi-xman: Agent "${agent.name}" 指定的 model "${agent.model}" 无法解析 (${resolved.error ?? "未找到"})，` +
          `已回退到主会话模型，请修复 agent 配置。`,
      );
      model = fallbackModel;
    } else {
      return `本次 agent 执行终止，返回内容: Agent "${agent.name}" 指定的 model "${agent.model}" 无法解析 (${resolved.error ?? "未找到"})。`;
    }
  } else {
    model = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  }

  // --- Abort scope（external signal + timeout） ---
  const scope = new SubagentAbortScope(signal, timeoutMs);

  let childSession: AgentSession | undefined;
  let turnCount = 0;
  let finalAssistantText = "";
  let finalStopReason: string | undefined;
  let finalErrorMessage: string | undefined;

  // --- shouldStopAfterTurn for precise turn budget ---
  // Runs after turn_end (tools done, before next LLM call), guarantees
  // no N+1-th model call. Only toolUse triggers another LLM request;
  // stop/length/error/aborted are terminal and should not be blocked.
  // Counts assistant messages from ctx.newMessages (loop-level) instead of
  // subscribe() events, because the hook fires synchronously at turn_end and
  // the subscribe callback timing relative to the hook is undefined.
  let stoppedByTurnBudget = false;
  const turnBudgetHook =
    maxTurns !== undefined
      ? (ctx: ShouldStopAfterTurnContext) => {
          const assistantCount = ctx.newMessages.filter((m) => m.role === "assistant").length;
          if (assistantCount < maxTurns) return false;
          if (ctx.message.stopReason !== "toolUse") return false;
          turnCount = assistantCount;
          stoppedByTurnBudget = true;
          return true;
        }
      : undefined;

  // --- Create resourceLoader ---
  const childSessionManager = SessionManager.inMemory(cwd);
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
    appendSystemPrompt: [],
  });

  try {
    if (scope.aborted) {
      return scope.terminationMessage();
    }

    await resourceLoader.reload();

    if (scope.aborted) {
      return scope.terminationMessage();
    }

    const result = await createAgentSession({
      cwd,
      modelRegistry,
      sessionManager: childSessionManager,
      model,
      thinkingLevel,
      tools: agent.tools,
      resourceLoader,
      shouldStopAfterTurn: turnBudgetHook,
    });

    childSession = result.session;
    scope.setSession(childSession);

    if (scope.aborted) {
      return scope.terminationMessage();
    }

    // Bind extensions so session_start handlers can register dynamic tools
    await childSession.bindExtensions({});

    if (scope.aborted) {
      return scope.terminationMessage();
    }

    // --- Set up event collection with turn counting ---

    const unsubscribe = childSession.subscribe((event) => {
      if (event.type === "message_end") {
        const msg = event.message;

        if (msg.role === "assistant") {
          turnCount++;
          finalStopReason = msg.stopReason;
          finalErrorMessage = msg.errorMessage;
          const textContent = msg.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n");
          if (textContent) {
            finalAssistantText = textContent;
          }
        }
      }
    });

    try {
      await childSession.prompt(userPrompt, {
        expandPromptTemplates: false,
        source: "extension",
      });

      if (scope.aborted) {
        return scope.terminationMessage(finalAssistantText);
      }

      // Detecting terminal stop reasons that are not successful completions.
      if (finalStopReason === "error" || finalStopReason === "aborted") {
        return `本次 agent 执行终止，返回内容: 执行异常 - ${finalErrorMessage || "未知错误"}${finalAssistantText ? "。最后输出: " + finalAssistantText : ""}`;
      }
      if (finalStopReason === "length") {
        return `本次 agent 执行终止，返回内容: 输出被截断（达到 token 上限），请缩小任务范围或提高输出预算重试。最后输出: ${finalAssistantText || "(无输出)"}`;
      }

      if (stoppedByTurnBudget) {
        return `本次 agent 执行终止，返回内容: 达到最大轮数（${maxTurns}），已完成 ${turnCount} 轮对话${finalAssistantText ? "。最后输出: " + finalAssistantText : ""}`;
      }

      return `本次 agent 执行完成，返回内容: ${finalAssistantText || "(无输出)"}`;
    } finally {
      unsubscribe();
    }
  } catch (err: any) {
    if (scope.aborted) {
      return scope.terminationMessage(finalAssistantText);
    }
    return `本次 agent 执行终止，返回内容: 执行异常 - ${err?.message || "未知错误"}`;
  } finally {
    scope.dispose();
    if (childSession) {
      try {
        childSession.dispose();
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
