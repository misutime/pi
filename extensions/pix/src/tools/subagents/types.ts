export interface IAgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  systemPrompt: string;
  filePath: string;
}

