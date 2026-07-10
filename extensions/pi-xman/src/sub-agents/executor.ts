/**
 * Subagent executor — creates child sessions and runs subagent tasks.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createExtensionRuntime,
  type ModelRegistry,
  resolveCliModel,
  type ResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { IAgentConfig, ToolCallSummary, UsageSummary } from "./types.ts";
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
}

// ============================================================================
// Headless ResourceLoader
// ============================================================================

function createHeadlessResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// ============================================================================
// Executor
// ============================================================================

export async function runSubagent(options: SubagentRunOptions) {
  const { agent, task, cwd, modelRegistry, signal } = options;

  // --- Build prompts ---
  const systemPrompt = buildSubagentSystemPrompt(agent);
  const userPrompt = buildSubagentUserPrompt(agent, task);

  // --- Resolve model ---
  let model: Model<any> | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  if (agent.model) {
    const resolved = resolveCliModel({ cliModel: agent.model, modelRegistry });

    if (resolved.error || !resolved.model) {
      return {
        status: "invalid_agent_model",
        agent: agent.name,
        summary: `Agent "${agent.name}" specifies model "${agent.model}" which could not be resolved.`,
        details: resolved.error ?? `Model "${agent.model}" was not found.`,
        messages: [],
      };
    }

    model = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  }

  // --- Create child session ---
  const childSessionManager = SessionManager.inMemory(cwd);
  const headlessLoader = createHeadlessResourceLoader(systemPrompt);
  let childSession;

  try {
    const result = await createAgentSession({
      cwd,
      modelRegistry,
      sessionManager: childSessionManager,
      model,
      thinkingLevel,
      tools: agent.tools,
      resourceLoader: headlessLoader,
    });

    childSession = result.session;

    // --- Set up event collection ---
    let finalAssistantText = "";
    const collectedToolCalls: ToolCallSummary[] = [];
    const collectedMessages: AgentMessage[] = [];
    let collectedUsage: UsageSummary = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    };

    const unsubscribe = childSession.subscribe((event) => {
      if (event.type === "message_end") {
        const msg = event.message;
        collectedMessages.push(msg);

        if (msg.role === "assistant") {
          collectedUsage.turns++;
          const amsg = msg as AssistantMessage;
          const u = amsg.usage;
          if (u) {
            collectedUsage.input += u.input || 0;
            collectedUsage.output += u.output || 0;
            collectedUsage.cacheRead += u.cacheRead || 0;
            collectedUsage.cacheWrite += u.cacheWrite || 0;
          }
          // Access cost with a safe path (pi-ai compat may have it at usage.cost.total)
          const costTotal = (u as any)?.cost?.total;
          if (typeof costTotal === "number") {
            collectedUsage.cost += costTotal;
          }
          // Collect final text from the last assistant message
          const textContent = amsg.content
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

      if (event.type === "tool_execution_start") {
        collectedToolCalls.push({
          name: event.toolName,
          args: event.args as Record<string, unknown>,
        });
      }
    });

    // --- Set up abort propagation ---
    let aborted = false;
    if (signal) {
      const onAbort = () => {
        aborted = true;
        childSession!.abort().catch(() => {});
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      await childSession.prompt(userPrompt, {
        expandPromptTemplates: false,
        source: "extension",
      });

      return {
        details: finalAssistantText || "(no output before abort)",
      };
    } finally {
      unsubscribe();
    }
  } catch (err: any) {
    return {
      status: "protocol_failure",
      agent: agent.name,
      summary: `Subagent execution failed: ${err?.message || "Unknown error"}`,
      details: err?.stack || err?.message || "Unknown error",
      messages: [],
    };
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
