/** SubAgent RPC method names. */
export const SubAgentMethods = {
	/** Parent → Worker: start a task. */
	Run: "agent/run",
	/** Parent → Worker: cancel a running task. */
	Cancel: "agent/cancel",
	/** Worker → Parent: progress notification (tool call started). */
	Progress: "agent/progress",
} as const;

/** Configuration passed from parent to worker on spawn. */
export interface SubAgentConfig {
	cwd: string;
	agentDir: string;
	parentSession?: string;
	sessionDir: string;
	maxTurns?: number;
	/** Agent name (from user config). Used for identification only. */
	agentName: string;
	/** Model string to resolve (e.g. "anthropic/claude-opus-4-5"). */
	agentModel: string;
	/** Tool allowlist for this agent. */
	agentTools: string[];
	/** Custom system prompt for this agent. */
	agentSystemPrompt: string;
}

/** Params for agent/run request. */
export interface RunParams {
	agentId: string;
	task: string;
	config: SubAgentConfig;
}

/** Params for agent/progress notification. */
export interface ProgressParams {
	agentId: string;
	name: string;
}

/** Result from a successful agent/run. */
export interface RunResult {
	output: string;
	sessionPath: string;
	truncated: boolean;
}
