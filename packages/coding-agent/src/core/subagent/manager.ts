import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { RunResult } from "./protocol.ts";
import type { SubagentRuntime } from "./runtime.ts";
import type { IAgentConfig } from "./types.ts";

const spawnAgentSchema = Type.Object({
	agent: Type.String({
		description: "Name of the agent to invoke (from ~/.pi/agent/agents/*.md)",
	}),
	task: Type.String({
		description: "The task for the agent to complete. Include ALL context the agent needs.",
	}),
});

interface SpawnAgentDetails {
	sessionPath: string;
	truncated: boolean;
	error?: string;
}

function buildSubagentSystemPromptAppend(agents: IAgentConfig[]): string {
	const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
	return [
		"## Sub-agents",
		"",
		"You can spawn sub-agents via the spawn_agent tool. Each sub-agent is an isolated pi instance",
		"with its own tools, model, and instructions. spawn_agent is BLOCKING — it waits for the sub-agent to finish.",
		"",
		"Available agents:",
		agentList,
		"",
		"- Use `spawn_agent` with the agent name from the list above.",
		"- The `task` parameter MUST include ALL context the agent needs.",
		"- Spawn multiple agents in parallel when tasks are independent.",
		"- When a sub-agent fails or produces truncated output, TELL the user.",
	].join("\n");
}

export class AgentManager {
	private _runtime: SubagentRuntime;
	private _cwd: string;
	private _agentDir: string;
	private _sessionDir: string;
	private _sessionFile: string | undefined;
	private _agents: IAgentConfig[];

	constructor(opts: {
		runtime: SubagentRuntime;
		cwd: string;
		agentDir: string;
		sessionDir: string;
		sessionFile?: string;
		agents: IAgentConfig[];
	}) {
		this._runtime = opts.runtime;
		this._cwd = opts.cwd;
		this._agentDir = opts.agentDir;
		this._sessionDir = opts.sessionDir;
		this._sessionFile = opts.sessionFile;
		this._agents = opts.agents;
	}

	/** Update session references (called when session changes). */
	updateSession(sessionFile: string | undefined): void {
		this._sessionFile = sessionFile;
	}

	/** Build the system prompt appendix listing available agents. */
	getSystemPromptAppend(): string {
		return buildSubagentSystemPromptAppend(this._agents);
	}

	getToolDefinition(): ToolDefinition<typeof spawnAgentSchema, SpawnAgentDetails> {
		const self = this;
		const agentNames = this._agents.map((a) => a.name);

		return {
			name: "spawn_agent",
			label: "Spawn Agent",
			description: `Spawn a specialized sub-agent to handle a complex subtask. Each agent has its own tools, model, and instructions. Available agents: ${agentNames.join(", ") || "(none)"}`,
			parameters: spawnAgentSchema,
			async execute(
				_toolCallId: string,
				params: Static<typeof spawnAgentSchema>,
				signal: AbortSignal | undefined,
				onUpdate,
				_ctx: ExtensionContext,
			): Promise<AgentToolResult<SpawnAgentDetails>> {
				const agentConfig = self._agents.find((a) => a.name === params.agent);
				if (!agentConfig) {
					const available = agentNames.join(", ") || "(none)";
					return {
						content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${available}` }],
						details: { sessionPath: "", truncated: false, error: `Unknown agent: ${params.agent}` },
					};
				}

				try {
					const result: RunResult = await self._runtime.run(
						params.task,
						{
							cwd: self._cwd,
							agentDir: self._agentDir,
							parentSession: self._sessionFile,
							sessionDir: self._sessionDir,
							agentName: agentConfig.name,
							agentModel: agentConfig.model,
							agentTools: agentConfig.tools,
							agentSystemPrompt: agentConfig.systemPrompt,
						},
						signal,
						(toolName) => {
							onUpdate?.({
								content: [{ type: "text", text: `Subagent: ${toolName}` }],
								details: {} as SpawnAgentDetails,
							});
						},
					);
					return {
						content: [{ type: "text", text: result.output }],
						details: { sessionPath: result.sessionPath, truncated: result.truncated },
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Subagent failed: ${message}` }],
						details: {
							sessionPath: "",
							truncated: false,
							error: message,
						},
					};
				}
			},
		};
	}
}
