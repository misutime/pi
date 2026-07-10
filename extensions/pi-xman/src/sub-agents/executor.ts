/**
 * Subagent executor — creates child sessions and runs subagent tasks.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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
}

// ============================================================================
// Executor
// ============================================================================

export async function runSubagent(options: SubagentRunOptions): Promise<string> {
  const { agent, task, cwd, modelRegistry, signal, fallbackModel } = options;

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

  // --- Set up abort signal early so it covers reload and session creation ---
  let aborted = false;
  let onAbort: (() => void) | undefined;

  if (signal) {
    onAbort = () => {
      aborted = true;
    };
    if (signal.aborted) {
      aborted = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const cleanupSignal = () => {
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const abortMessage = () =>
    `本次 agent 执行终止，返回内容: 任务被中断${finalAssistantText ? "。最后输出: " + finalAssistantText : ""}`;

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

  let childSession: AgentSession | undefined;
  let finalAssistantText = "";

  try {
    if (aborted) {
      return abortMessage();
    }

    await resourceLoader.reload();

    if (aborted) {
      return abortMessage();
    }

    const result = await createAgentSession({
      cwd,
      modelRegistry,
      sessionManager: childSessionManager,
      model,
      thinkingLevel,
      tools: agent.tools,
      resourceLoader,
    });

    childSession = result.session;

    if (aborted) {
      childSession.abort().catch(() => {});
      return abortMessage();
    }

    // Bind extensions so session_start handlers can register dynamic tools
    await childSession.bindExtensions({});

    if (aborted) {
      childSession.abort().catch(() => {});
      return abortMessage();
    }

    // Upgrade signal handler: now we have a session, so abort() it on signal
    if (signal && !aborted) {
      cleanupSignal();
      onAbort = () => {
        aborted = true;
        childSession?.abort()?.catch(() => {});
      };
      if (signal.aborted) {
        aborted = true;
        childSession.abort().catch(() => {});
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // --- Set up event collection ---

    const unsubscribe = childSession.subscribe((event) => {
      if (event.type === "message_end") {
        const msg = event.message;

        if (msg.role === "assistant") {
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

      if (aborted) {
        return abortMessage();
      }

      return `本次 agent 执行完成，返回内容: ${finalAssistantText || "(无输出)"}`;
    } finally {
      unsubscribe();
      cleanupSignal();
    }
  } catch (err: any) {
    if (aborted) {
      return abortMessage();
    }
    return `本次 agent 执行终止，返回内容: 执行异常 - ${err?.message || "未知错误"}`;
  } finally {
    if (childSession) {
      try {
        childSession.dispose();
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
