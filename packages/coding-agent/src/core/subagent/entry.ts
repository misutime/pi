/**
 * Subagent worker entry point.
 *
 * Forked by SubagentRuntime. Receives tasks via JSON-RPC over Node IPC,
 * creates a child AgentSession with the agent's specific model/tools/systemPrompt,
 * runs it headless, and sends the result back before disconnecting.
 */

import { join } from "node:path";
import type { AgentSession } from "../agent-session.ts";
import { AuthStorage } from "../auth-storage.ts";
import { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel } from "../model-resolver.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { JsonRpcPeer, WorkerIpcTransport } from "../rpc/index.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { ProgressParams, RunParams, RunResult, SubAgentConfig } from "./protocol.ts";
import { SubAgentMethods } from "./protocol.ts";

interface ContentBlock {
	type: string;
	text?: string;
}

let currentController: AbortController | undefined;
let abortListener: (() => void) | undefined;

class CancelError extends Error {
	constructor() {
		super("Cancelled");
		this.name = "CancelError";
	}
}

const transport = new WorkerIpcTransport();
const peer = new JsonRpcPeer(transport);
peer.start();

peer.onRequest(SubAgentMethods.Run, async (params) => {
	const { agentId, task, config } = params as RunParams;
	try {
		return await handleRun(agentId, task, config);
	} finally {
		// Defer disconnect until the current stack unwinds so the RPC layer
		// has called transport.send() before we close the IPC channel.
		setImmediate(() => process.disconnect());
	}
});

peer.onNotification(SubAgentMethods.Cancel, () => {
	currentController?.abort();
});

function buildAgentSystemPrompt(config: SubAgentConfig): string {
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
		config.agentSystemPrompt.trim() || `You are the "${config.agentName}" specialist agent.`,
		"",
		"---",
		"",
		"COMPLETION",
		"",
		"Your last assistant message must summarize the result in natural language:",
		"- Describe whether the task succeeded or failed, and why.",
		"- Include specific evidence: file paths, code snippets, search results, or error details.",
		"- Do not ask the user for input. If blocked, explain the reason clearly.",
	].join("\n");
}

function buildAgentUserPrompt(config: SubAgentConfig, task: string): string {
	return ["AGENT", config.agentName, "", "TASK", task].join("\n");
}

async function handleRun(agentId: string, task: string, config: SubAgentConfig): Promise<RunResult> {
	const controller = new AbortController();
	currentController = controller;

	let childSession: AgentSession | undefined;
	let finalAssistantText = "";
	let finalStopReason: string | undefined;
	let finalErrorMessage: string | undefined;
	let stoppedByTurnBudget = false;

	try {
		const checkCancelled = (): void => {
			if (controller.signal.aborted) throw new CancelError();
		};

		const sessionManager = SessionManager.create(config.cwd, config.sessionDir);
		if (config.parentSession !== undefined) {
			sessionManager.newSession({ parentSession: config.parentSession });
		} else {
			sessionManager.newSession();
		}
		const sessionPath = sessionManager.getSessionFile();
		if (sessionPath === undefined) {
			throw new Error("Subagent requires persistent session manager");
		}
		checkCancelled();

		const systemPrompt = buildAgentSystemPrompt(config);
		const resourceLoader = new DefaultResourceLoader({
			cwd: config.cwd,
			agentDir: config.agentDir,
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPrompt,
			appendSystemPrompt: [],
		});
		await resourceLoader.reload();
		checkCancelled();

		const authPath = join(config.agentDir, "auth.json");
		const modelsPath = join(config.agentDir, "models.json");
		const authStorage = AuthStorage.create(authPath);
		const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
		const resolved = resolveCliModel({ cliModel: config.agentModel, modelRegistry });

		if (resolved.error || !resolved.model) {
			throw new Error(
				`Agent "${config.agentName}" model "${config.agentModel}" could not be resolved: ${resolved.error ?? "Unknown error"}`,
			);
		}

		const { session } = await createAgentSession({
			cwd: config.cwd,
			agentDir: config.agentDir,
			sessionManager,
			resourceLoader,
			model: resolved.model,
			modelRegistry,
			authStorage,
			tools: config.agentTools,
			excludeTools: ["spawn_agent"],
			shouldStopAfterTurn: (ctx) => {
				if (ctx.message.stopReason !== "toolUse") return false;
				const count = ctx.newMessages.filter((m) => m.role === "assistant").length;
				if (count < (config.maxTurns ?? 10)) return false;
				stoppedByTurnBudget = true;
				return true;
			},
		});
		childSession = session;

		abortListener = () => {
			void childSession!.abort()?.catch(() => {});
		};
		controller.signal.addEventListener("abort", abortListener, { once: true });
		checkCancelled();

		await childSession.bindExtensions({});
		checkCancelled();

		const unsubscribe = childSession.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				peer.notify(SubAgentMethods.Progress, {
					agentId,
					name: event.toolName,
				} satisfies ProgressParams);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				finalStopReason = event.message.stopReason;
				if ("errorMessage" in event.message && typeof event.message.errorMessage === "string") {
					finalErrorMessage = event.message.errorMessage;
				}
				finalAssistantText = extractText(event.message.content);
			}
		});

		const userPrompt = buildAgentUserPrompt(config, task);

		try {
			await childSession.prompt(userPrompt, {
				expandPromptTemplates: false,
				source: "extension",
			});
		} finally {
			unsubscribe();
		}

		checkCancelled();

		if (finalStopReason === "error") {
			throw new Error(finalErrorMessage || "Agent error");
		}
		if (finalStopReason === "aborted") {
			throw new Error("Agent aborted");
		}

		const truncated = finalStopReason === "length" || stoppedByTurnBudget;
		let output = finalAssistantText || "(no output)";
		if (finalStopReason === "length") output = `[Output truncated]\n${output}`;
		if (stoppedByTurnBudget) output = `[Max turns reached]\n${output}`;
		output = truncateOutput(output, 50 * 1024, 500);

		return { output, sessionPath, truncated };
	} catch (err) {
		if (err instanceof CancelError) {
			throw new Error("Cancelled");
		}
		throw err;
	} finally {
		currentController = undefined;
		abortListener = undefined;
		// Clean up child session
		if (childSession) {
			try {
				childSession.dispose();
			} catch {
				/* best-effort */
			}
		}
	}
}

function extractText(content: string | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is ContentBlock & { text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function truncateOutput(text: string, maxBytes: number, maxLines: number): string {
	const totalLines = text.split("\n").length;
	const totalBytes = Buffer.byteLength(text, "utf-8");

	const markers: string[] = [];
	if (totalLines > maxLines) {
		markers.push(`[Truncated: ${totalLines} lines total]`);
	}
	if (totalBytes > maxBytes) {
		markers.push(`[Truncated: ${(totalBytes / 1024).toFixed(1)} KB total]`);
	}
	if (markers.length === 0) return text;

	const suffix = markers.join("\n");
	const suffixBytes = Buffer.byteLength(`\n${suffix}`, "utf-8");
	if (maxBytes <= suffixBytes) {
		let truncated = "";
		for (const ch of `\n${suffix}`) {
			const next = truncated + ch;
			if (Buffer.byteLength(next, "utf-8") > maxBytes) break;
			truncated = next;
		}
		return truncated;
	}

	const headBytes = maxBytes - suffixBytes;
	let lines = text.split("\n");
	if (totalLines > maxLines) lines = lines.slice(0, maxLines);

	let result = "";
	for (let i = 0; i < lines.length; i++) {
		const sep = result ? "\n" : "";
		const full = result + sep + lines[i];
		if (Buffer.byteLength(full, "utf-8") <= headBytes) {
			result = full;
			continue;
		}
		let partial = result ? result + sep : "";
		for (const ch of lines[i]) {
			const next = partial + ch;
			if (Buffer.byteLength(next, "utf-8") > headBytes) break;
			partial = next;
		}
		result = partial;
		break;
	}

	return `${result}\n${suffix}`;
}
