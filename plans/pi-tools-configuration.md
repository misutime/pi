# pi Tools 配置完整指南

## 层级架构

Tools 配置分三层：

```
注册层 (哪些工具存在)
  -> 过滤层 (哪些工具允许暴露)
    -> 激活层 (哪些工具当前对 LLM 可见)
```

| 层级 | 机制 | 位置 |
|------|------|------|
| 注册 | 内置 7 个 + 扩展 registerTool() | core/tools/index.ts / extensions |
| 过滤 | allowedToolNames / excludedToolNames | AgentSessionConfig (硬过滤) |
| 激活 | setActiveTools() / CLI flags | 运行时可变 |

---

## 内置工具

定义于 `packages/coding-agent/src/core/tools/index.ts`，共 7 个：

```ts
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
```

| 工具 | 默认激活 | 说明 |
|------|----------|------|
| `read` | Yes | 读取文件内容 |
| `bash` | Yes | 执行 shell 命令 |
| `edit` | Yes | 精确替换编辑文件 |
| `write` | Yes | 创建/覆写文件 |
| `grep` | No | 搜索文件内容 (只读) |
| `find` | No | glob 模式查找文件 (只读) |
| `ls` | No | 列出目录内容 (只读) |

`grep`、`find`、`ls` 是只读工具，默认不激活。可通过 CLI allowlist 或扩展启用。

---

## 配置入口

### 1. CLI 参数

文件：`packages/coding-agent/src/cli/args.ts` (`Args` 接口) -> `packages/coding-agent/src/main.ts` L443-446 映射到 SDK 选项。

| 参数 | 短写 | 类型 | 说明 |
|------|------|------|------|
| `--tools <name,...>` | `-t` | allowlist | 仅启用列出的工具 (覆盖默认 4 个) |
| `--exclude-tools <name,...>` | `-xt` | denylist | 禁用列出的工具 (在 allowlist 之后应用) |
| `--no-tools` | `-nt` | boolean | 禁用所有工具 (内置 + 扩展) |
| `--no-builtin-tools` | `-nbt` | boolean | 仅禁用内置工具，保留扩展工具 |

示例：

```bash
# 只读模式
pi --tools read,grep,find,ls "Review the codebase"

# 启用默认 4 个 + grep
pi -t read,bash,edit,write,grep

# 纯聊天模式 (无工具)
pi --no-tools "Explain this concept"

# 排除单个工具
pi --exclude-tools bash "Read the code, don't run commands"
```

### 2. SDK 编程接口

文件：`packages/coding-agent/src/core/sdk.ts`

```ts
export interface CreateAgentSessionOptions {
    noTools?: "all" | "builtin";
    tools?: string[];           // allowlist
    excludeTools?: string[];    // denylist
    customTools?: ToolDefinition[];
}
```

过滤逻辑 (sdk.ts L247-260)：

```ts
const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;

const initialActiveToolNames: string[] = (
    options.tools
        ? [...options.tools]           // allowlist 指定了 -> 用它
        : options.noTools
            ? []                        // --no-tools -> 空
            : defaultActiveToolNames    // 默认 4 个
).filter((name) => !excludedToolNameSet?.has(name));  // 再减去 denylist
```

### 3. AgentSessionConfig (硬过滤)

文件：`packages/coding-agent/src/core/agent-session.ts`

```ts
export interface AgentSessionConfig {
    initialActiveToolNames?: string[];       // 初始活跃，默认 ["read","bash","edit","write"]
    allowedToolNames?: string[];             // 硬 allowlist，之后无法通过 setActiveTools 绕过
    excludedToolNames?: string[];            // 硬 denylist
    customTools?: ToolDefinition[];
    baseToolsOverride?: Record<string, AgentTool>;  // 完全替换内置工具
}
```

`allowedToolNames` 和 `excludedToolNames` 是硬过滤：不在 allowlist 中的工具不会出现在 registry 中，`setActiveTools()` 也无法添加。过滤逻辑在 `_refreshToolRegistry()` 方法中实现。

---

## 运行时 API

### Extension API

文件：`packages/coding-agent/src/core/extensions/types.ts`

```ts
interface ExtensionAPI {
    getActiveTools(): string[];                    // 当前活跃的工具名列表
    getAllTools(): ToolInfo[];                     // 所有已注册工具 (含 schema/描述/来源)
    setActiveTools(toolNames: string[]): void;     // 动态切换活跃工具
    registerTool(tool: ToolDefinition): void;      // 注册新工具
}
```

`ToolInfo` 类型：

```ts
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
    sourceInfo: SourceInfo;  // { source: "builtin" | "sdk" | "extension", path? }
};
```

### AgentHarness 层

文件：`packages/agent/src/harness/agent-harness.ts`

- `getActiveTools(): TTool[]` -- 返回当前活跃工具对象数组
- `setActiveTools(toolNames: string[]): void` -- 设置活跃工具，写入 session 的 `active_tools_change` entry，触发 `tools_update` 事件
- `activeToolNames` -- 内部维护的活跃工具名数组
- 每次 `createTurnState()` 时，从 `activeToolNames` 解析出实际 `activeTools` 对象传给 Agent

### tool_call 事件 (运行时阻断)

扩展可以在工具执行前实时阻断：

```ts
pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && isDangerous(event.input.command)) {
        return { block: true, reason: "Blocked: dangerous command" };
    }
});
```

阻断返回值：

```ts
export interface ToolCallEventResult {
    block?: boolean;    // 设为 true 阻止执行
    reason?: string;    // 原因说明
}
```

事件类型包括：`BashToolCallEvent`、`ReadToolCallEvent`、`EditToolCallEvent`、`WriteToolCallEvent`、`GrepToolCallEvent`、`FindToolCallEvent`、`LsToolCallEvent`、`CustomToolCallEvent`。`event.input` 可被修改以在验证后改变参数。

---

## 扩展注册自定义工具

`ToolDefinition` 关键字段：

| 字段 | 说明 |
|------|------|
| `name` | 工具唯一名称 |
| `description` | LLM 可见的描述 |
| `promptSnippet` | 系统 prompt 中 "Available tools" 部分的单行摘要 |
| `promptGuidelines` | 系统 prompt 中 Guidelines 部分的提示点 |
| `parameters` | TypeBox schema (参数定义) |
| `executionMode` | `"sequential"` 或 `"parallel"` |
| `execute` | 实际执行函数 |

示例：

```ts
import { defineTool, Type } from "@earendil-works/pi-coding-agent";

pi.registerTool(defineTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful.",
    promptSnippet: "Use my_tool to do X.",
    promptGuidelines: ["Always check Y before calling my_tool."],
    parameters: Type.Object({
        input: Type.String({ description: "The input value" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
        const result = await doSomething(params.input);
        return { content: [{ type: "text", text: result }] };
    },
}));
```

---

## Preset 配置

文件：`~/.pi/agent/presets.json` 或 `<cwd>/.pi/presets.json` (项目优先覆盖全局)

```json
{
    "plan": {
        "provider": "openai-codex",
        "model": "gpt-5.2-codex",
        "thinkingLevel": "high",
        "tools": ["read", "grep", "find", "ls"],
        "instructions": "You are in PLANNING MODE. Do not make changes."
    },
    "implement": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "thinkingLevel": "high",
        "tools": ["read", "bash", "edit", "write"],
        "instructions": "You are in IMPLEMENTATION MODE."
    }
}
```

使用：

```bash
pi --preset plan                # CLI 启动时激活
/preset plan                    # 会话中切换
/preset                         # 打开 TUI 选择器
Ctrl+Shift+U                    # 循环预设
```

(需要安装 `preset` 扩展：`examples/extensions/preset.ts`)

---

## Session 持久化

Active tools 变更自动写入 session (`active_tools_change` entry)，恢复 session 时会重新应用。

```ts
// packages/agent/src/harness/types.ts
export interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
    type: "active_tools_change";
    activeToolNames: string[];
}
```

写入点：
- `AgentHarness.setActiveTools()` -> `session.appendActiveToolsChange()`
- `AgentSession.setActiveToolsByName()` -> 通过 agent harness 间接写入

恢复点：
- Session replay 时重放 `active_tools_change` entry
- `tools.ts` 扩展通过 `appendEntry("tools-config")` 持久化用户选择，`session_start` / `session_tree` 事件中恢复

---

## 示例扩展参考

| 扩展 | 文件 | 关键 API |
|------|------|----------|
| /tools 选择器 | `examples/extensions/tools.ts` | `getActiveTools`, `setActiveTools`, `getAllTools`, `appendEntry` |
| /preset 切换 | `examples/extensions/preset.ts` | `getActiveTools`, `setActiveTools`, `registerFlag`, `registerShortcut` |
| /plan 只读模式 | `examples/extensions/plan-mode/index.ts` | `getActiveTools`, `setActiveTools`, `tool_call` 阻断 |

---

## 关键源文件索引

| 文件 | 内容 |
|------|------|
| `packages/coding-agent/src/cli/args.ts` | CLI 参数定义与解析 |
| `packages/coding-agent/src/main.ts` | CLI -> SDK 选项映射 |
| `packages/coding-agent/src/core/sdk.ts` | `CreateAgentSessionOptions` 及初始过滤逻辑 |
| `packages/coding-agent/src/core/agent-session.ts` | `AgentSessionConfig`、`_refreshToolRegistry()`、`setActiveToolsByName()` |
| `packages/coding-agent/src/core/tools/index.ts` | 7 个内置工具定义 |
| `packages/coding-agent/src/core/extensions/types.ts` | `ExtensionAPI`、`ToolDefinition`、`ToolInfo`、`ToolCallEvent` |
| `packages/agent/src/harness/agent-harness.ts` | `getActiveTools()`、`setActiveTools()`、`activeToolNames` |
| `packages/agent/src/harness/types.ts` | `ActiveToolsChangeEntry` |

---

## 配置优先级

```
CLI flags > Preset 配置 > 默认值 (["read","bash","edit","write"])
```

`allowedToolNames` / `excludedToolNames` 在 `AgentSessionConfig` 中是硬过滤，运行时 `setActiveTools()` 无法绕过。所有工具名最终通过 `_refreshToolRegistry()` 的 `isAllowedTool()` 函数过滤后才进入 registry。
