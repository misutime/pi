/** User-defined agent configuration from ~/.pi/agent/agents/*.md */
export interface IAgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	systemPrompt: string;
	filePath: string;
}
