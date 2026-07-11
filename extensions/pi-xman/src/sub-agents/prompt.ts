/**
 * Subagent prompt construction.
 *
 * Builds the system prompt and user prompt for child agent sessions.
 * The system prompt includes the agent's role instructions and the completion protocol.
 */

import type { IAgentConfig } from "./types.ts";
// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for a subagent session.
 *
 * Contains:
 * 1. Headless subagent identity
 * 2. Agent-specific role instructions
 * 3. Completion protocol instructions
 */
export function buildSubagentSystemPrompt(agent: IAgentConfig): string {
  return [
    "You are running as a headless subagent.",
    "",
    "You must complete the assigned task without asking the user for input.",
    "Use only the tools available to you.",
    "",
    "---",
    "",
    "ROLE",
    "",
    agent.systemPrompt.trim() ||
      `You are the "${agent.name}" specialist agent.`,
    "",
    "---",
    "",
    "COMPLETION",
    "",
    "Your last assistant message must summarize the result in natural language:",
    "- Describe whether the task succeeded or failed, and why.",
    "- Include specific evidence: file paths, code snippets, search results, or error details.",
    "- Do not ask the user for input. If blocked, explain the reason clearly.",
    "",
    "If the task cannot be completed because critical information is missing",
    "(e.g., ambiguous file paths, unclear requirements, missing parameters),",
    "your last message MUST use this exact format:",
    "",
    "本次 agent 求助, 具体问题: {describe exactly what information is missing}",
    "请你补充上下文再 call_agent 调用一次",
  ].join("\n");
}

// ============================================================================
// User Prompt
// ============================================================================

/**
 * Build the user prompt for a subagent session.
 *
 * Simple task assignment with agent identity.
 */
export function buildSubagentUserPrompt(
  agent: IAgentConfig,
  task: string,
): string {
  return ["AGENT", agent.name, "", "TASK", task].join("\n");
}
