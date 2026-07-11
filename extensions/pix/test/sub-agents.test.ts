import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsFromDir } from "../src/tools/subagents/loader.ts";
import {
  buildSubagentSystemPrompt,
  buildSubagentUserPrompt,
} from "../src/tools/subagents/prompt.ts";
import { runSubagent } from "../src/tools/subagents/executor.ts";
import type { IAgentConfig } from "../src/tools/subagents/types.ts";
import callAgent from "../src/tools/subagents/call-agent.ts";
import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  Model,
  Context,
  StreamOptions,
  FauxProviderRegistration,
  FauxResponseFactory,
  FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/compat";

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `pi-xman-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAgentConfig(overrides: Partial<IAgentConfig> = {}): IAgentConfig {
  return {
    name: "test-agent",
    description: "A test agent",
    tools: ["read", "grep"],
    model: "test-provider/test-model",
    systemPrompt: "You are a test agent.",
    filePath: "/tmp/test-agent.md",
    ...overrides,
  };
}

function setupAgentDirEnv(tempDir: string): string | undefined {
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir;
  return original;
}

function restoreAgentDirEnv(original: string | undefined): void {
  if (original) {
    process.env.PI_CODING_AGENT_DIR = original;
  } else {
    delete process.env.PI_CODING_AGENT_DIR;
  }
}

function writeAgentFile(
  agentsDir: string,
  filename: string,
  content: string,
): string {
  const filePath = join(agentsDir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function createModelRegistry(): ModelRegistry {
  const authStorage = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(authStorage);
  return registry;
}

function registerTestModel(registry: ModelRegistry): void {
  registry.registerProvider("test-provider", {
    baseUrl: "http://localhost:1",
    apiKey: "test-key",
    api: "openai",
    models: [
      {
        id: "test-model",
        name: "Test Model",
        api: "openai" as const,
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 4096,
      },
    ],
  });
}

interface FauxRegistryResult {
  modelRegistry: ModelRegistry;
  modelString: string;
  faux: FauxProviderRegistration;
  fallbackModel: Model<string>;
  cleanup: () => void;
}

/**
 * Set up a ModelRegistry with a faux provider ready to respond.
 * Accepts either a plain text string (wraps into fauxAssistantMessage)
 * or an array of FauxResponseStep values.
 */
function setupFauxRegistry(
  responseTextOrSteps: string | FauxResponseStep[],
): FauxRegistryResult {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  const faux = registerFauxProvider({ models: [{ id: "faux-model", reasoning: false }] });

  if (typeof responseTextOrSteps === "string") {
    faux.setResponses([fauxAssistantMessage(responseTextOrSteps)]);
  } else {
    faux.setResponses(responseTextOrSteps);
  }

  const model = faux.getModel();
  authStorage.setRuntimeApiKey(model.provider, "faux-key");
  modelRegistry.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      baseUrl: m.baseUrl,
    })),
  });

  return {
    modelRegistry,
    modelString: `${model.provider}/${model.id}`,
    faux,
    fallbackModel: model,
    cleanup: () => {
      faux.unregister();
    },
  };
}

// ============================================================================
// loadAgentsFromDir
// ============================================================================

describe("loadAgentsFromDir", () => {
  let agentsDir: string;
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = createTempDir();
    originalEnv = setupAgentDirEnv(tempDir);
    agentsDir = join(tempDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    restoreAgentDirEnv(originalEnv);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("parses a valid agent markdown", () => {
    writeAgentFile(
      agentsDir,
      "valid.md",
      [
        "---",
        "name: code-reviewer",
        "description: 审查代码",
        "model: deepseek/deepseek-chat",
        "tools:",
        "  - read",
        "  - grep",
        "---",
        "You are a code reviewer.",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(errors).toEqual([]);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("code-reviewer");
    expect(agents[0].description).toBe("审查代码");
    expect(agents[0].model).toBe("deepseek/deepseek-chat");
    expect(agents[0].tools).toEqual(["read", "grep"]);
    expect(agents[0].systemPrompt).toContain("You are a code reviewer.");
  });

  it("parses comma-separated tools string", () => {
    writeAgentFile(
      agentsDir,
      "comma-tools.md",
      [
        "---",
        "name: tester",
        "description: 测试",
        "model: faux/model",
        "tools: read, grep, bash",
        "---",
        "test body",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(errors).toEqual([]);
    expect(agents[0].tools).toEqual(["read", "grep", "bash"]);
  });

  it("returns empty tools array when tools is not specified", () => {
    writeAgentFile(
      agentsDir,
      "no-tools.md",
      [
        "---",
        "name: bare",
        "description: 无工具",
        "model: faux/model",
        "---",
        "bare agent",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(errors).toEqual([]);
    expect(agents[0].tools).toEqual([]);
  });

  it("collects error for invalid YAML", () => {
    writeAgentFile(
      agentsDir,
      "bad-yaml.md",
      [
        "---",
        "name: broken",
        "description: 坏 YAML",
        "model: faux/model",
        "tools: [unclosed",
        "---",
        "broken yaml",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad-yaml.md");
    expect(errors[0]).toContain("YAML 解析失败");
  });

  it("collects error for missing name", () => {
    writeAgentFile(
      agentsDir,
      "no-name.md",
      [
        "---",
        "description: 缺少 name",
        "model: faux/model",
        "---",
        "no name",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no-name.md");
    expect(errors[0]).toContain("缺少 name");
  });

  it("collects error for missing description", () => {
    writeAgentFile(
      agentsDir,
      "no-desc.md",
      [
        "---",
        "name: nodesc",
        "model: faux/model",
        "---",
        "no description",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no-desc.md");
    expect(errors[0]).toContain("缺少 description");
  });

  it("collects error for missing model", () => {
    writeAgentFile(
      agentsDir,
      "no-model.md",
      [
        "---",
        "name: nomodel",
        "description: 没有 model",
        "---",
        "no model",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no-model.md");
    expect(errors[0]).toContain("缺少 model");
  });

  it("collects error for non-string tools", () => {
    writeAgentFile(
      agentsDir,
      "bad-tools.md",
      [
        "---",
        "name: badtools",
        "description: 非字符串 tools",
        "model: faux/model",
        "tools:",
        "  - read",
        "  - 42",
        "  - true",
        "---",
        "bad tools",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    // Agent still loads with valid tools only
    expect(agents).toHaveLength(1);
    expect(agents[0].tools).toEqual(["read"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad-tools.md");
    expect(errors[0]).toContain("不是字符串");
  });

  it("collects multiple errors across files", () => {
    writeAgentFile(
      agentsDir,
      "bad1.md",
      ["---", "name: missing-desc", "model: faux/model", "---", "body"].join(
        "\n",
      ),
    );
    writeAgentFile(
      agentsDir,
      "bad2.md",
      [
        "---",
        "description: missing name",
        "model: faux/model",
        "---",
        "body",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it("skips non-markdown files", () => {
    writeFileSync(join(agentsDir, "readme.txt"), "not an agent", "utf-8");

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("collects error when name is a number instead of string", () => {
    writeAgentFile(
      agentsDir,
      "num-name.md",
      [
        "---",
        "name: 42",
        "description: 数字 name",
        "model: faux/model",
        "---",
        "body",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("num-name.md");
    expect(errors[0]).toContain("缺少 name");
  });

  it("collects error when name is a boolean instead of string", () => {
    writeAgentFile(
      agentsDir,
      "bool-name.md",
      [
        "---",
        "name: true",
        "description: 布尔 name",
        "model: faux/model",
        "---",
        "body",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bool-name.md");
    expect(errors[0]).toContain("缺少 name");
  });

  it("collects error when description is a number instead of string", () => {
    writeAgentFile(
      agentsDir,
      "num-desc.md",
      [
        "---",
        "name: agent1",
        "description: 123",
        "model: faux/model",
        "---",
        "body",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("num-desc.md");
    expect(errors[0]).toContain("缺少 description");
  });

  it("collects error when model is a number instead of string", () => {
    writeAgentFile(
      agentsDir,
      "num-model.md",
      [
        "---",
        "name: agent2",
        "description: 数字 model",
        "model: 99",
        "---",
        "body",
      ].join("\n"),
    );

    const { agents, errors } = loadAgentsFromDir();

    expect(agents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("num-model.md");
    expect(errors[0]).toContain("缺少 model");
  });
});

// ============================================================================
// buildSubagentSystemPrompt / buildSubagentUserPrompt
// ============================================================================

describe("prompt", () => {
  it("includes headless instructions and role body", () => {
    const prompt = buildSubagentSystemPrompt(
      makeAgentConfig({ systemPrompt: "Be concise and helpful." }),
    );

    expect(prompt).toContain("headless subagent");
    expect(prompt).toContain("ROLE");
    expect(prompt).toContain("Be concise and helpful.");
    expect(prompt).toContain("natural language");
    expect(prompt).toContain("COMPLETION");
  });

  it("does not contain old SUBAGENT_RESULT format", () => {
    const prompt = buildSubagentSystemPrompt(makeAgentConfig());

    expect(prompt).not.toContain("SUBAGENT_RESULT");
    expect(prompt).not.toContain("status: success");
  });

  it("uses agent name fallback when systemPrompt is empty", () => {
    const prompt = buildSubagentSystemPrompt(
      makeAgentConfig({ name: "my-agent", systemPrompt: "" }),
    );

    expect(prompt).toContain("my-agent");
    expect(prompt).toContain("specialist agent");
  });

  it("buildSubagentUserPrompt includes agent name and task", () => {
    const prompt = buildSubagentUserPrompt(
      makeAgentConfig(),
      "review PR #42",
    );

    expect(prompt).toContain("test-agent");
    expect(prompt).toContain("review PR #42");
  });

  it("includes help request protocol for missing information", () => {
    const prompt = buildSubagentSystemPrompt(makeAgentConfig());

    expect(prompt).toContain("本次 agent 求助, 具体问题:");
    expect(prompt).toContain("请你补充上下文再 call_agent 调用一次");
  });
});

// ============================================================================
// runSubagent
// ============================================================================

describe("runSubagent", () => {
  let tempDir: string;
  let originalEnv: string | undefined;
  let modelRegistry: ModelRegistry;

  beforeEach(() => {
    tempDir = createTempDir();
    originalEnv = setupAgentDirEnv(tempDir);
    mkdirSync(join(tempDir, "agents"), { recursive: true });
    modelRegistry = createModelRegistry();
    registerTestModel(modelRegistry);
  });

  afterEach(() => {
    restoreAgentDirEnv(originalEnv);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  // --- Pre-abort ---

  it("returns abort message when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagent({
      agent: makeAgentConfig(),
      task: "do something",
      cwd: tempDir,
      modelRegistry,
      signal: controller.signal,
    });

    expect(result).toContain("本次 agent 执行终止");
    expect(result).toContain("任务被中断");
  });

  // --- Model not found, no fallback ---

  it("returns error when model cannot be resolved and no fallback", async () => {
    const result = await runSubagent({
      agent: makeAgentConfig({ model: "nonexistent/bad-model" }),
      task: "do something",
      cwd: tempDir,
      modelRegistry,
    });

    expect(result).toContain("本次 agent 执行终止");
    expect(result).toContain("nonexistent/bad-model");
    expect(result).toContain("无法解析");
  });

  // --- Faux-driven success path ---

  it("executes successfully with faux provider and returns assistant text", async () => {
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry("task completed: found 3 files");

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "list files",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
      });

      expect(result).toContain("本次 agent 执行完成");
      expect(result).toContain("task completed: found 3 files");
    } finally {
      cleanup();
    }
  });

  // --- Tools allowlist: empty tools ---

  it("passes empty tools to provider context when agent has tools: []", async () => {
    let capturedContext: Context | undefined;

    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        (ctx: Context) => {
          capturedContext = ctx;
          return fauxAssistantMessage("done with no tools");
        },
      ]);

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString, tools: [] }),
        task: "simple analysis",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
      });

      expect(result).toContain("本次 agent 执行完成");
      expect(result).toContain("done with no tools");
      expect(capturedContext).toBeDefined();
      expect(capturedContext!.tools).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // --- Fallback model ---

  it("uses fallbackModel when agent model cannot be resolved", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { modelRegistry: fauxRegistry, modelString, fallbackModel, cleanup } =
      setupFauxRegistry("fallback response");

    try {
      // Use a registry that only has the faux provider registered,
      // so "nonexistent/model" cannot resolve to any model.
      const result = await runSubagent({
        agent: makeAgentConfig({ model: "nonexistent/model" }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        fallbackModel,
      });

      expect(result).toContain("本次 agent 执行完成");
      expect(result).toContain("fallback response");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Agent "test-agent" 指定的 model "nonexistent/model" 无法解析'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("已回退到主会话模型"),
      );
    } finally {
      warnSpy.mockRestore();
      cleanup();
    }
  });

  // --- Abort during prompt ---

  it("propagates abort signal to provider via session.abort during prompt", async () => {
    const abortSpy = vi.spyOn(AgentSession.prototype, "abort");

    // Factory that listens on options.signal for the abort event,
    // verifying that session.abort() propagates all the way to the provider.
    let signalWasAborted = false;
    let factoryEntered = false;
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        (_ctx: Context, options: StreamOptions | undefined) => {
          factoryEntered = true;
          return new Promise<ReturnType<typeof fauxAssistantMessage>>(
            (resolve, reject) => {
              if (options?.signal) {
                if (options.signal.aborted) {
                  signalWasAborted = true;
                  reject(new DOMException("Aborted", "AbortError"));
                  return;
                }
                options.signal.addEventListener(
                  "abort",
                  () => {
                    signalWasAborted = true;
                    reject(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true },
                );
              } else {
                // Safety net: reject after a long timeout so the test fails
                // cleanly instead of hanging if the signal is missing.
                setTimeout(
                  () =>
                    reject(new Error("provider did not receive abort signal")),
                  5000,
                );
              }
            },
          );
        },
      ]);

    const controller = new AbortController();

    try {
      const resultPromise = runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        signal: controller.signal,
      });

      // Wait for the factory to be entered before triggering abort,
      // eliminating the race-prone fixed delay.
      await vi.waitFor(() => expect(factoryEntered).toBe(true), {
        timeout: 3000,
        interval: 10,
      });
      controller.abort();

      const result = await resultPromise;

      expect(result).toContain("任务被中断");
      expect(abortSpy).toHaveBeenCalled();
      // This is the key assertion: the abort signal propagated from
      // session.abort() all the way through to the provider's stream options.
      expect(signalWasAborted).toBe(true);
    } finally {
      abortSpy.mockRestore();
      cleanup();
    }
  });

  // --- Timeout ---

  it("aborts when timeoutMs is exceeded", async () => {
    // Factory that delays 500ms; timeout of 100ms should abort first.
    // The factory checks the signal so it rejects cleanly when abort propagates.
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        (_ctx: Context, options: StreamOptions | undefined) =>
          new Promise<ReturnType<typeof fauxAssistantMessage>>(
            (resolve, reject) => {
              const id = setTimeout(
                () => resolve(fauxAssistantMessage("too late")),
                500,
              );
              if (options?.signal) {
                options.signal.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(id);
                    reject(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true },
                );
              }
            },
          ),
      ]);

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        timeoutMs: 100,
      });

      expect(result).toContain("本次 agent 执行终止");
      expect(result).toContain("超时（100ms）");
    } finally {
      cleanup();
    }
  });

  it("completes normally when task completes within timeout", async () => {
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry("completed quickly");

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        timeoutMs: 5000,
      });

      expect(result).toContain("本次 agent 执行完成");
      expect(result).not.toContain("超时");
    } finally {
      cleanup();
    }
  });

  // --- Max turns ---

  it("allows up to maxTurns assistant messages to complete", async () => {
    // maxTurns=1 should allow a single-turn task with stopReason=stop to complete.
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry("single turn response");

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        maxTurns: 1,
      });

      expect(result).toContain("本次 agent 执行完成");
      expect(result).toContain("single turn response");
      expect(result).not.toContain("超过最大轮数");
    } finally {
      cleanup();
    }
  });

  // --- Provider error/aborted detection ---

  it("returns execution failure when agent produces error stopReason", async () => {
    // The agent converts provider errors to stopReason="error" and
    // resolves prompt() normally. Executor must detect this.
    // Use a factory so retry doesn't exhaust the response queue.
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        () =>
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "model overloaded",
          }),
      ]);

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
      });

      expect(result).toContain("本次 agent 执行终止");
      expect(result).toContain("执行异常");
      expect(result).not.toContain("本次 agent 执行完成");
    } finally {
      cleanup();
    }
  });

  it("returns execution failure when agent produces aborted stopReason", async () => {
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        fauxAssistantMessage("partial output", {
          stopReason: "aborted",
        }),
      ]);

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
      });

      expect(result).toContain("本次 agent 执行终止");
      expect(result).toContain("执行异常");
      expect(result).toContain("partial output");
      expect(result).not.toContain("本次 agent 执行完成");
    } finally {
      cleanup();
    }
  });

  it("reports output truncation when agent stops with length", async () => {
    // stopReason="length" means the model hit the token limit —
    // the output is incomplete and should not be reported as success.
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        fauxAssistantMessage("truncated incomplete result", {
          stopReason: "length",
        }),
      ]);

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
      });

      expect(result).toContain("本次 agent 执行终止");
      expect(result).toContain("输出被截断");
      expect(result).toContain("truncated incomplete result");
      expect(result).not.toContain("本次 agent 执行完成");
    } finally {
      cleanup();
    }
  });

  // --- Max turns toolUse prevention ---

  it("prevents next model call when maxTurns reached with toolUse", async () => {
    // First response returns a tool call (stopReason=toolUse).
    // With maxTurns=1 via shouldStopAfterTurn, the agent loop stops after
    // turn_end, before making a second LLM request.
    const authStorage = AuthStorage.inMemory();
    const fauxRegistry = ModelRegistry.inMemory(authStorage);
    const faux = registerFauxProvider({
      models: [{ id: "faux-mt", reasoning: false }],
    });
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall("read", { path: "/" }),
          { stopReason: "toolUse" },
        ),
    ]);
    const model = faux.getModel();
    authStorage.setRuntimeApiKey(model.provider, "faux-key");
    fauxRegistry.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      apiKey: "faux-key",
      api: faux.api,
      models: faux.models.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({
          model: `${model.provider}/${model.id}`,
          tools: ["read"],
        }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        maxTurns: 1,
      });

      expect(result).toContain("本次 agent 执行终止");
      expect(result).toContain("达到最大轮数（1）");
      // shouldStopAfterTurn prevents the second LLM call entirely.
      expect(faux.state.callCount).toBe(1);
    } finally {
      faux.unregister();
    }
  });

  it("completes normally when turn count stays within maxTurns", async () => {
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry("only one turn");

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        maxTurns: 5,
      });

      expect(result).toContain("本次 agent 执行完成");
      expect(result).not.toContain("超过最大轮数");
    } finally {
      cleanup();
    }
  });

  // --- Abort during bindExtensions (before prompt) ---

  it("never calls provider when aborted before bindExtensions", async () => {
    // Spy to capture bindExtensions and trigger abort before the real call
    const abortSpy = vi.spyOn(AgentSession.prototype, "abort");
    const originalBindExtensions = AgentSession.prototype.bindExtensions;

    const controller = new AbortController();

    AgentSession.prototype.bindExtensions = async function (
      this: AgentSession,
      ...args: Parameters<AgentSession["bindExtensions"]>
    ) {
      // Trigger abort before calling the original bindExtensions
      controller.abort();
      // Let the microtask queue process the abort event
      await new Promise((r) => setTimeout(r, 10));
      return originalBindExtensions.apply(this, args);
    };

    const { modelRegistry: fauxRegistry, modelString, faux, cleanup } =
      setupFauxRegistry("should never be returned");

    try {
      const result = await runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        signal: controller.signal,
      });

      expect(result).toContain("任务被中断");
      // The provider must never have been invoked
      expect(faux.state.callCount).toBe(0);
    } finally {
      AgentSession.prototype.bindExtensions = originalBindExtensions;
      abortSpy.mockRestore();
      cleanup();
    }
  });

  // --- Timeout fires before external signal, reason not overwritten ---

  it("keeps timeout reason when external signal fires later", async () => {
    // Factory delays 500ms; timeout at 100ms should win.
    const { modelRegistry: fauxRegistry, modelString, cleanup } =
      setupFauxRegistry([
        (_ctx: Context, options: StreamOptions | undefined) =>
          new Promise<ReturnType<typeof fauxAssistantMessage>>(
            (resolve, reject) => {
              const id = setTimeout(
                () => resolve(fauxAssistantMessage("too late")),
                500,
              );
              if (options?.signal) {
                options.signal.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(id);
                    reject(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true },
                );
              }
            },
          ),
      ]);

    const controller = new AbortController();

    try {
      const resultPromise = runSubagent({
        agent: makeAgentConfig({ model: modelString }),
        task: "do something",
        cwd: tempDir,
        modelRegistry: fauxRegistry,
        signal: controller.signal,
        timeoutMs: 100,
      });

      // After timeout fires (100ms), also trigger external abort
      await new Promise((r) => setTimeout(r, 150));
      controller.abort();

      const result = await resultPromise;

      // Timeout reason should win, not "任务被中断"
      expect(result).toContain("超时（100ms）");
      expect(result).not.toContain("任务被中断");
    } finally {
      cleanup();
    }
  });
});

// ============================================================================
// call_agent tool (call-agent.ts)
// ============================================================================

describe("call_agent", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = createTempDir();
    originalEnv = setupAgentDirEnv(tempDir);
    mkdirSync(join(tempDir, "agents"), { recursive: true });
  });

  afterEach(() => {
    restoreAgentDirEnv(originalEnv);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  // Helper: register the call_agent tool and return its execute function
  function registerCallAgentTool(): {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: Partial<ExtensionContext>,
    ) => Promise<{
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }>;
  } {
    let capturedTool: {
      execute: (...args: unknown[]) => Promise<unknown>;
    } | null = null;
    const mockPi = {
      registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }) {
        capturedTool = tool;
      },
    } as unknown as ExtensionAPI;
    callAgent(mockPi);
    if (!capturedTool) {
      throw new Error("callAgent did not register a tool");
    }
    return {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: Partial<ExtensionContext>,
      ) =>
        capturedTool!.execute(toolCallId, params, signal, onUpdate, ctx) as Promise<{
          content: Array<{ type: string; text: string }>;
          details: Record<string, unknown>;
        }>,
    };
  }

  // Helper: create a minimal ExtensionContext mock
  function mockCtx(overrides: {
    cwd?: string;
    modelRegistry?: ModelRegistry;
    model?: Model<string>;
  } = {}): Partial<ExtensionContext> {
    return {
      cwd: overrides.cwd ?? tempDir,
      modelRegistry: overrides.modelRegistry ?? createModelRegistry(),
      model: overrides.model,
    };
  }

  it("throws when agent configurations have errors", () => {
    writeAgentFile(
      join(tempDir, "agents"),
      "bad-yaml.md",
      [
        "---",
        "name: broken",
        "description: 坏 YAML",
        "model: faux/model",
        "tools: [unclosed",
        "---",
        "body",
      ].join("\n"),
    );

    expect(() => {
      callAgent({ registerTool: () => {} } as unknown as ExtensionAPI);
    }).toThrow("pi-xman: agent 配置错误");
  });

  it("returns error for unknown agent name", async () => {
    // Register with no agent files → empty agents list
    const { execute } = registerCallAgentTool();

    const result = await execute(
      "tid-1",
      { agent: "nonexistent-agent", task: "do something" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("Unknown agent");
    expect(result.content[0].text).toContain("nonexistent-agent");
    expect(result.details.error).toContain("Unknown agent");
  });

  it("returns error for empty task", async () => {
    writeAgentFile(
      join(tempDir, "agents"),
      "valid.md",
      [
        "---",
        "name: tester",
        "description: 测试",
        "model: faux/faux-1",
        "---",
        "body",
      ].join("\n"),
    );

    const { execute } = registerCallAgentTool();

    const result = await execute(
      "tid-1",
      { agent: "tester", task: "" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("Missing or invalid 'task'");
    expect(result.details.error).toContain("Missing or invalid 'task'");
  });

  it("returns error for whitespace-only task", async () => {
    writeAgentFile(
      join(tempDir, "agents"),
      "valid.md",
      [
        "---",
        "name: tester",
        "description: 测试",
        "model: faux/faux-1",
        "---",
        "body",
      ].join("\n"),
    );

    const { execute } = registerCallAgentTool();

    const result = await execute(
      "tid-1",
      { agent: "tester", task: "   " },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("must not be empty");
    expect(result.details.error).toContain("must not be empty");
  });

  it("returns formatted result for successful execution", async () => {
    writeAgentFile(
      join(tempDir, "agents"),
      "valid.md",
      [
        "---",
        "name: helper",
        "description: 助手",
        "model: faux/faux-model",
        "---",
        "You are a helper.",
      ].join("\n"),
    );

    const { modelRegistry, modelString, cleanup } =
      setupFauxRegistry("analysis complete: all tests pass");

    try {
      const { execute } = registerCallAgentTool();

      const ctx = mockCtx({ modelRegistry });
      const result = await execute(
        "tid-1",
        { agent: "helper", task: "run analysis" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain(
        "analysis complete: all tests pass",
      );
      expect(result.details).toEqual({});
    } finally {
      cleanup();
    }
  });

  it("returns error result for call_agent when subagent execution fails", async () => {
    writeAgentFile(
      join(tempDir, "agents"),
      "valid.md",
      [
        "---",
        "name: helper",
        "description: 助手",
        "model: nonexistent/model",
        "---",
        "body",
      ].join("\n"),
    );

    const { execute } = registerCallAgentTool();

    const ctx = mockCtx({ modelRegistry: createModelRegistry() });
    const result = await execute(
      "tid-1",
      { agent: "helper", task: "do work" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("本次 agent 执行终止");
    // Not wrapped in "Error:" prefix — it's the subagent's error message
    expect(result.content[0].text).not.toContain("Error:");
    expect(result.details).toEqual({});
  });
});
