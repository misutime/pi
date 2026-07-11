/**
 * Call Agent extension — delegate tasks to specialized sub-agents.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadAgentsFromDir } from "./loader.ts";
import { runSubagent } from "./executor.ts";

export default function callAgent(pi: ExtensionAPI): void {
  const { agents, errors } = loadAgentsFromDir();

  if (errors.length > 0) {
    throw new Error(
      `pi-xman: agent 配置错误，请修复后重试：\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  const agentList =
    agents.length > 0
      ? agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n")
      : "(no agents configured)";

  pi.registerTool({
    name: "call_agent",
    label: "Call Agent",
    description: `Delegate a task to a specialized sub-agent with isolated context.
The sub-agent runs headless, uses only its configured tools, and returns a natural language result.

Available agents:\n${agentList}`,
    parameters: Type.Object({
      agent: Type.String({
        description: "Name of the specialized agent to invoke",
      }),
      task: Type.String({ description: "Task to delegate to the agent" }),
    }),
    execute: async (
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) => {
      const { agent: agentName, task } = params;

      // --- Validate ---
      if (!agentName || typeof agentName !== "string") {
        return formatInvalidRequest("Missing or invalid 'agent' parameter.");
      }
      if (!task || typeof task !== "string") {
        return formatInvalidRequest("Missing or invalid 'task' parameter.");
      }
      if (task.trim().length === 0) {
        return formatInvalidRequest("'task' parameter must not be empty.");
      }

      const agentConfig = agents.find((a) => a.name === agentName);
      if (!agentConfig) {
        return formatInvalidRequest(
          `Unknown agent '${agentName}'. Available agents: ${agents.map((a) => a.name).join(", ") || "(none)"}`,
        );
      }

      // --- Execute ---
      const result = await runSubagent({
        agent: agentConfig,
        task: task.trim(),
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        signal,
        fallbackModel: ctx.model,
        timeoutMs: 10 * 60 * 1000, // 10 minutes
        maxTurns: 30,
      });

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
        details: {},
      };
    },
  });
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatInvalidRequest(message: string): AgentToolResult<any> {
  return {
    content: [
      {
        type: "text",
        text: "Error: " + message,
      },
    ],
    details: { error: message },
  };
}
