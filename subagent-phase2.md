# SubAgent Phase 2 设计

## 概述

Phase 1 实现前台阻塞模式 + 2 工具（spawn_agent / list_agents）。Phase 2 增加：

- 后台模式（background spawn）
- wait_agent / close_agent / send_message 工具
- 用户配置 agent（~/.pi/agent/agents/*.md）
- 完整 TUI session 导航
- Bun binary 支持

---

## 一、后台模式

### 1.1 工具契约变更

spawn_agent 增加 `mode: "background"` 参数：

```typescript
parameters: Type.Object({
  task: Type.String({ ... }),
  mode: Type.Optional(Type.Union([
    Type.Literal("foreground"),   // 默认
    Type.Literal("background"),
  ])),
}),
```

### 1.2 后台流程

```
1. Main LLM: spawn_agent({ task: "...", mode: "background" })

2. Agent Manager: fork → send run → 立刻 resolve tool call
   返回: "Agent abc-1 started in background."

3. Main LLM 继续当前 turn

4. Worker 跑 agent loop（同时）

5. Worker 完成 → Agent Manager 收到 result

6. Agent Manager:
   - 主 agent 空闲 → triggerTurn: true → 立即唤醒
   - 主 agent 流式中 → deliverAs: "nextTurn" → 排队
   注入: <subagent_notification agent_id="abc-1" status="completed">输出</subagent_notification>
```

### 1.3 onBackgroundComplete

```typescript
onBackgroundComplete(agentId: string, result: SubagentResult): void {
  const message = {
    content: [{ type: "text", text: formatNotification(result) }],
    display: `Subagent ${agentId} ${result.error ? "✗" : "✓"}`,
    details: { agentId, sessionPath: result.sessionPath, ... },
  };

  if (this._isStreaming()) {
    this._sendToSession(message, { deliverAs: "nextTurn" });
  } else {
    this._sendToSession(message, { triggerTurn: true });
  }
}
```

---

## 二、新增工具

### 2.1 wait_agent

```typescript
{
  name: "wait_agent",
  description: "Wait for a background sub-agent to finish.",
  parameters: Type.Object({
    target: Type.String({ description: "Agent id (from spawn_agent output)." }),
    timeout_ms: Type.Optional(Type.Number({
      description: "Timeout in ms (default 120000).",
      minimum: 1000, maximum: 600000, default: 120000,
    })),
  }),
}
```

### 2.2 close_agent

```typescript
{
  name: "close_agent",
  description: "Close a completed sub-agent and release process resources.",
  parameters: Type.Object({
    target: Type.String({ description: "Agent id to close." }),
  }),
}
```

`SubagentRuntime` 中 `close(agentId)` 删除终态 handle。

### 2.3 send_message

```typescript
{
  name: "send_message",
  description: "Send an additional message to a running background sub-agent.",
  parameters: Type.Object({
    target: Type.String({ description: "Agent id." }),
    message: Type.String({ description: "Message to send." }),
  }),
}
```

Worker 中处理：IPC 到达 → 若 session 流式中则以 `streamingBehavior: "steer"` 注入；否则入 pending 队列。

---

## 三、用户配置 Agent

### 3.1 配置文件

`~/.pi/agent/agents/<name>.md`：

```markdown
---
name: researcher
description: Specialized agent for code research and analysis.
model: anthropic/claude-sonnet-4-20250514
tools: read, grep, ls, find, websearch
---

You are a research specialist. Your job is to deeply analyze codebases
and produce clear, structured reports. Focus on accuracy and completeness.
```

### 3.2 加载器

```typescript
// core/subagent/loader.ts
export interface AgentConfig {
  name: string;
  description: string;
  tools: string[];         // 工具白名单
  model: string;           // provider/model 格式
  systemPrompt: string;    // markdown body
  filePath: string;
}

export function loadAgents(): { agents: AgentConfig[]; errors: string[] };
```

解析 `~/.pi/agent/agents/` 下的所有 `.md` 文件，YAML frontmatter + body。无效文件跳过并记录 error。

### 3.3 spawn_agent 参数扩展

spawn_agent 增加 `agent_type` 参数：

```typescript
agent_type: Type.Optional(Type.String({
  description: "Agent type name from ~/.pi/agent/agents/. Omit for default.",
})),
```

AgentManager 根据 `agent_type` 查找配置 → 覆盖 tools / model / systemPrompt。

---

## 四、TUI Session 导航

spawn_agent 工具的 `renderResult` 渲染可点击入口：

```typescript
renderResult: (result, options, theme, ctx) => {
  const { agentId, sessionPath, ... } = result.details;
  // TUI Component: Box + Text + [Enter] View full session
  // 用户按 Enter → pi.switchSession(sessionPath)
};
```

用户在子 agent 会话中查看完整对话后，可切换回主会话。

---

## 五、Bun Binary 支持

### 5.1 方案

Phase 1 Worker 入口是编译后的 `entry.js`（Node + tsx loader）。Bun binary 需要内置 worker：

- 方案 A：`spawn("pi", ["internal:subagent", "--task", task, "--config", config])` 使用 pi 二进制自调用
- 方案 B：将 worker 打包进 Bun binary 的虚拟模块，fork 时直接运行

### 5.2 需解决的问题

- Worker 进程的 `createAgentSession` 调用路径
- Bun binary 中的模块解析（虚拟模块）
- 跨进程认证传递（可能需要在 worker 启动参数中传 token 或 agentDir）

---

## 六、IPC 协议扩展

```typescript
// 新增 ParentMessage
type ParentMessage =
  | ...  // Phase 1: run / cancel
  | { type: "message"; content: string };   // send_message

// WorkerMessage 不变（Phase 1 已完备）
```

---

## 七、改动清单

| 文件 | 改动 |
|---|---|
| `core/subagent/loader.ts` | **新建** — 加载 ~/.pi/agent/agents/*.md |
| `core/subagent/entry.ts` | 改 — message IPC 处理 |
| `core/subagent/runtime.ts` | 改 — onBackgroundComplete / sendMessage |
| `core/subagent/manager.ts` | 改 — 3 个新工具 + renderResult |
| `core/agent-session.ts` | 改 — 注入 3 个新工具 |

---

## 八、Phase 2 对比 Phase 1

| | Phase 1 | Phase 2 |
|---|---|---|
| 模式 | 前台阻塞 | 前台 + 后台 |
| 工具 | spawn_agent + list_agents（2） | + wait_agent / close_agent / send_message（5） |
| 模型 | settings 默认 | 每 agent 可指定 |
| agent 配置 | 内置（general） | ~/.pi/agent/agents/*.md |
| 工具集 | 全部 pi 工具（- 2 个 subagent） | 每 agent 白名单 |
| systemPrompt | 内置 | 每 agent 自定义 |
| 递归 spawn | 禁止 | 可配置 |
| TUI | 工具行进度 | 完整 session 导航 |
| Bun binary | ❌ | ✅ |
