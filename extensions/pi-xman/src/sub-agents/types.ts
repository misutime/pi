export interface IAgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}
export interface ToolCallSummary {
  name: string;
  args: Record<string, unknown>;
}
export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
