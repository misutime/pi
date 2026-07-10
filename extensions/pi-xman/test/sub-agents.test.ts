import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsFromDir } from "../src/sub-agents/loader.ts";
import {
  buildSubagentSystemPrompt,
  buildSubagentUserPrompt,
} from "../src/sub-agents/prompt.ts";
import { runSubagent } from "../src/sub-agents/executor.ts";
import type { IAgentConfig } from "../src/sub-agents/types.ts";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

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
});
