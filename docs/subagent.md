# SubAgent 实现逻辑

## 概述

SubAgent 是 Pi 从单 Agent Runtime 向多 Agent Runtime 演进的基础设施。当前 Phase 1 实现了**可靠的前台子 agent 委派**：父 agent 通过 `spawn_agent` 工具，按用户预定义的 agent 配置，fork 独立子进程运行子 agent，阻塞等待结果后返回。

## 为什么这样设计

### 为什么用 fork 而不是 spawn + stdio

SubAgent 是 Node 进程 fork Node 进程，`fork()` 是最优选择：

- **IPC 开箱即用** — 不需要处理 Content-Length、半包、粘包等 stdio 字节流问题
- **stdout 留给日志** — `console.log()` 不会污染协议通道，与 RPC 天然分离
- **入口清晰** — `fork(workerPath, args)` 一行即可
- **Node-to-Node 最优方案** — 支持结构化消息传递

### 为什么用 JSON-RPC 而不是裸 IPC 消息

裸 IPC 的第一版很简单，但随着消息类型增加，会暴露大量手工样板：

| 裸 IPC 需自己解决 | JSON-RPC 内置 |
|-------------------|---------------|
| 哪个响应对应哪个请求 | request ID + pending map |
| 多请求并发 | pending map 天然支持 |
| 超时 | `peer.request()` 内置参数 |
| 取消 | `agent/cancel` 通知 + `peer.cancelRequest()` |
| 结构化错误 | `RpcError { code, message, data }` |
| 未知 method | `MethodNotFound` 标准错误 |
| notification 分发 | `peer.onNotification()` 统一 |

统一 JSON-RPC 的另一层收益：**为 LSP 接入铺路**。LSP 本身基于 JSON-RPC（spawn + stdio），SubAgent 也用 JSON-RPC（fork + Node IPC），上层 RPC 模型完全一致，只是 Transport 不同。

```
                ┌─────────────────┐
                │   JsonRpcPeer   │  ← 共用：request ID / pending / timeout / cancel
                └───┬─────────┬───┘
                    │         │
            ┌───────┴─┐  ┌───┴────────┐
            │ IPC     │  │ Stdio      │  ← Transport 不同，接口相同
            │ Transport│  │ Transport  │
            └───────┬─┘  └───┬────────┘
                    │         │
            fork()  │         │  spawn()
                    ▼         ▼
               SubAgent    LSP Server
```

## 架构

```
用户输入 "帮我研究这个项目" → 主 LLM
                                │
                                ▼
                         spawn_agent({
                           agent: "researcher",
                           task: "分析项目结构"
                         })
                                │
                                ▼
┌─────────────────── AgentManager ───────────────────┐
│  1. 按 agent 名查找 IAgentConfig（内存查找）         │
│  2. 构建 SubAgentConfig（含 model/tools/prompt）     │
│  3. 调用 SubagentRuntime.run()                     │
└───────────────────────┬────────────────────────────┘
                        │
                        ▼
┌────────────── SubagentRuntime ──────────────────────┐
│  1. fork(workerPath) → ChildProcess（stdio 全 ignore）│
│  2. 创建 NodeIpcTransport + JsonRpcPeer              │
│  3. peer.request("agent/run", { agentId, task, ...}) │
│  4. 设置超时/abort 监听                             │
│  5. 等待 RPC 响应 → RunResult 或 reject             │
│  6. 幂等 finalize，resolve Promise                  │
└──────────────────────┬─────────────────────────────┘
                       │  Node IPC + JSON-RPC
                       ▼
┌────────────── Worker 进程 (entry.ts) ───────────────┐
│  1. WorkerIpcTransport + JsonRpcPeer 启动            │
│  2. peer.onRequest("agent/run", handler)             │
│  3. 解析 agent model 字符串 → resolveCliModel()     │
│     └─ 失败则 throw，spawn_agent 返回明确错误        │
│  4. 构建 agent 专用 systemPrompt + userPrompt       │
│  5. createAgentSession({                            │
│       model: resolvedModel,                         │
│       tools: agent.tools,                           │
│       resourceLoader: { systemPrompt }              │
│     })                                              │
│  6. childSession.prompt(userPrompt)                 │
│  7. 工具调用 → peer.notify("agent/progress")        │
│  8. 收集输出、截断（50KB / 500 行）                  │
│  9. return RunResult 或 throw Error                 │
│ 10. setImmediate(() => process.disconnect())        │
└─────────────────────────────────────────────────────┘
```

## 文件结构

```
packages/coding-agent/src/core/
├── rpc/                    # 共享 RPC 层
│   ├── types.ts            # RpcRequest / RpcResponse / RpcNotification / ErrorCode
│   ├── transport.ts        # RpcTransport 接口 + NodeIpcTransport + WorkerIpcTransport
│   └── peer.ts             # JsonRpcPeer（request ID / pending map / timeout / cancel / notification）
│
└── subagent/               # SubAgent 业务层
    ├── types.ts            # IAgentConfig 接口
    ├── protocol.ts         # RPC method 常量 + 参数/结果类型
    ├── loader.ts           # 从 ~/.pi/agent/agents/*.md 加载用户 agent 配置
    ├── runtime.ts          # SubagentRuntime — fork + RPC 封装
    ├── entry.ts            # Worker 进程入口
    └── manager.ts          # AgentManager — spawn_agent 工具定义 + 系统提示词
```

## 核心组件

### 1. RPC 层 (`core/rpc/`)

复用型基础设施，为 SubAgent 和未来的 LSP 提供统一编程模型。

**JsonRpcPeer** — RPC 核心封装：

```typescript
const peer = new JsonRpcPeer(transport);
peer.start();

// 请求-响应（自动分配 ID、超时、pending 管理）
const result = await peer.request<RunResult>("agent/run", { task, config }, 120_000);

// 通知（fire-and-forget，不等待响应）
peer.notify("agent/progress", { name: "read" });

// 注册服务端 handler
peer.onRequest("agent/run", async (params) => { ... });

// 注册通知 handler，返回 unsubscribe 函数
const unsub = peer.onNotification("agent/progress", (params) => { ... });

// 取消
peer.cancelRequest(requestId);
peer.cancelAll();
peer.close();
```

**RpcTransport** — 传输层接口，当前两种实现：

| Transport | 创建方式 | 通信方式 | 使用方 |
|-----------|---------|---------|--------|
| `NodeIpcTransport` | `new NodeIpcTransport(child)` | `child.send()` / `child.on("message")` | SubAgent 父进程 |
| `WorkerIpcTransport` | `new WorkerIpcTransport()` | `process.send()` / `process.on("message")` | SubAgent Worker |

LSP 接入时将新增 `StdioTransport` 实现同一接口。

### 2. Worker 路径解析

SubAgent 由 `AgentSession` 构造时自动初始化，无需外部传参。worker 文件路径通过 `resolveSubagentWorkerPath()` 自动解析：

| 运行环境 | 路径 | execArgv |
|---------|------|----------|
| 开发（tsx） | `src/core/subagent/entry.ts` | `["--import", "tsx/esm"]` |
| 生产（npm） | `dist/core/subagent/entry.js` | 无 |
| Bun binary | throw Error（暂不支持） | — |

### 3. 认证模型

父进程和子进程**共用同一份认证文件**，不通过 IPC 传递任何凭证：

```
~/.pi/agent/
├── agents/          ← loader.ts 从这读 agent 配置
├── auth.json        ← 父和子共用（API key）
└── models.json      ← 父和子共用（模型元数据）
```

Worker 收到 `SubAgentConfig.agentDir`（与父进程相同）后，自己创建指向同一路径的 `AuthStorage` 和 `ModelRegistry`。父进程配置过的 API key，子进程自动可用。这保证了 model 配置中的 provider/model-id 能被正确解析和认证。

### 4. Agent 配置加载 (`loader.ts`)

从 `~/.pi/agent/agents/*.md` 加载 YAML frontmatter 格式的 agent 配置。

`AgentSession` 构造时调用 `loadAgentsFromDir(agentDir)` 一次性加载全部，结果存入 `AgentManager._agents[]`。`spawn_agent` 执行时只需 `Array.find()`，无磁盘 IO。

```markdown
---
name: researcher
description: 代码研究与分析专家
model: anthropic/claude-opus-4-5
tools: read, grep, ls, find
---
你是一个代码研究专家。深入分析代码库并生成清晰的结构化报告。
```

`IAgentConfig` 接口：

```typescript
interface IAgentConfig {
  name: string;         // agent 名称（唯一标识）
  description: string;  // 用途描述
  tools: string[];      // 工具白名单（空数组 = 零工具，不会回退为默认工具集）
  model: string;        // 模型标识（provider/model-id 格式）
  systemPrompt: string; // 自定义系统提示词（YAML body）
  filePath: string;     // 配置文件路径
}
```

解析失败的文件记录到 errors 但不阻塞启动。agents 为空时 spawn_agent 工具不注册。

### 5. JSON-RPC 协议 (`protocol.ts`)

SubAgent 专用 RPC method 常量：

```typescript
SubAgentMethods = {
  Run:      "agent/run",       // 父 → Worker：启动任务（request/response）
  Cancel:   "agent/cancel",  // 父 → Worker：取消任务（notification）
  Progress: "agent/progress",   // Worker → 父：工具调用进度（notification）
}
```

消息示例：

```json
// 父 → Worker（request）
{
  "jsonrpc": "2.0", "id": "req-uuid", "method": "agent/run",
  "params": {
    "agentId": "...",
    "task": "分析认证模块",
    "config": {
      "agentName": "researcher",
      "agentModel": "anthropic/claude-opus-4-5",
      "agentTools": ["read", "grep", "ls"],
      "agentSystemPrompt": "你是一个代码研究专家..."
    }
  }
}

// Worker → 父（response）
{ "jsonrpc": "2.0", "id": "req-uuid", "result": { "output": "...", "sessionPath": "...", "truncated": false } }

// Worker → 父（通知）
{ "jsonrpc": "2.0", "method": "agent/progress", "params": { "agentId": "...", "name": "read" } }
```

错误统一走 JSON-RPC error 响应：worker 内 `throw Error("...")` → `JsonRpcPeer._handleRequest` 自动转换为 `{ error: { code: -32603, message: "..." } }` → 父进程 `peer.request()` reject → `runtime.run()` throw。

### 6. SubagentRuntime (`runtime.ts`)

管理子进程生命周期的核心类。构造参数由 `resolveSubagentWorkerPath()` 提供。

**`run(task, config, signal, onProgress)` 流程**：

1. 检查并发上限（默认 5）和 signal 状态
2. `fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] })` — stdout/stderr 全部 ignore，仅 IPC 通信
3. 创建 `NodeIpcTransport` + `JsonRpcPeer`，注册 `agent/progress` 通知 → `onProgress`
4. 设置超时定时器（默认 120s）→ 触发 finalize + terminate
5. 监听 abort signal → 先发 `agent/cancel` 通知（优雅），3s 后 `SIGTERM` → `SIGKILL`
6. `peer.request("agent/run", params, timeoutMs)` — 发送任务，RPC 层自动处理请求级超时
7. 监听 worker `exit`/`error` 事件 → 异常兜底 finalize

**finalize（幂等）**：通过 `record.finalized` 标记保证只 resolve/reject 一次，清理所有 timer、listener、peer。

**shutdown()**：遍历所有活跃 record，reject pending promise，SIGKILL 所有 worker，清理 Map。在 `AgentSession.dispose()` 中自动调用。

### 7. Worker 进程 (`entry.ts`)

独立进程，启动即创建 `WorkerIpcTransport` + `JsonRpcPeer`，注册 `agent/run` request handler 和 `agent/cancel` notification handler。

**核心流程**：

1. 接收 `agent/run` 请求
2. 创建 `SessionManager`（disk-persisted，与父 session 同 `sessionDir`）
3. 解析 model：`AuthStorage.create(join(agentDir, "auth.json"))` + `ModelRegistry.create(...)` + `resolveCliModel({ cliModel })`
   - 解析失败 → `throw Error("Agent X model Y could not be resolved: ...")`，spawn_agent 收到明确错误
4. 构建 system prompt：HEADLESS 身份 + ROLE（agent 自定义） + COMPLETION 要求
5. 构建 user prompt：`AGENT\n{name}\n\nTASK\n{task}`
6. `createAgentSession({ model: resolvedModel, tools: agentTools, ... })` — 传解析后的 model 和工具白名单
   - `tools` 直接传 `config.agentTools`，空数组即零工具，不会回退为默认工具集
   - `excludeTools: ["spawn_agent"]` 禁止递归
7. `childSession.bindExtensions({})` + `childSession.prompt(userPrompt)`
8. 监听 `tool_execution_start` → `peer.notify("agent/progress")` 实时上报
9. 收集 `message_end(assistant)` → 判断 stopReason，截断输出（50KB / 500 行）
10. 正常完成 → `return { output, sessionPath, truncated }` → RPC 响应
11. 异常 → `throw Error(...)` → RPC error 响应
12. `finally` 中 `setImmediate(() => process.disconnect())` — 确保响应已发送后才断开 IPC

### 8. AgentManager (`manager.ts`)

暴露 `spawn_agent` 工具定义。

**工具参数**：

```typescript
{
  agent: Type.String(),  // 必填 — agent 名称（来自 ~/.pi/agent/agents/*.md）
  task: Type.String(),   // 必填 — 委派任务描述
}
```

**execute 流程**：

1. `self._agents.find(a => a.name === params.agent)` — 纯内存查找
2. 未找到 → 返回 `"Unknown agent X. Available: a, b, c"`
3. 构建 `SubAgentConfig`（含 model/tools/systemPrompt）
4. `runtime.run(task, config, signal, onProgress)` — 阻塞等待
5. `onUpdate` → tool progress 显示 "Subagent: toolName"
6. 成功 → `{ content: result.output, details: { sessionPath, truncated } }`
7. 失败（runtime.run throw）→ `{ content: "Subagent failed: ..." }`

**系统提示词**：`getSystemPromptAppend()` 动态列出所有可用 agent 及描述，仅在 `spawn_agent` 在活跃工具列表中时追加。

### 9. AgentSession 集成 (`agent-session.ts`)

构造时自动初始化，无需外部传参：

```typescript
const agentDir = config.agentDir ?? getAgentDir();
const { agents, errors } = loadAgentsFromDir(agentDir);
// errors 打印但不阻塞
if (agents.length > 0) {
  this._subagentRuntime = new SubagentRuntime({ workerPath, execArgv });
  this._subagentManager = new AgentManager({ ..., agents });
  // → spawn_agent 工具在 _buildRuntime 中被注册为 base tool
}
// agents 为空 → _subagentRuntime = undefined → 工具不存在
```

- **工具注册**：`_buildRuntime()` 中将 `AgentManager.getToolDefinition()` 加入 `_baseToolDefinitions`
- **系统提示词**：`_rebuildSystemPrompt()` 中当 `spawn_agent` 活跃时追加 agent 列表
- **生命周期**：`dispose()` 调用 `_subagentRuntime?.shutdown()` 清理所有 worker

## 入口条件（零配置）

User 只需在 `~/.pi/agent/agents/` 下放置 `.md` 配置文件。启动 pi 后自动生效，不需要任何额外参数或配置。没有 agent 文件时 spawn_agent 不存在，LLM 看不到也无法调用。

## 安全与隔离

| 机制 | 说明 |
|------|------|
| 进程隔离 | 子 agent 在独立 Node 进程中运行，崩溃不影响父进程，`stdio: ignore` 防止 pipe buffer 阻塞 |
| 递归防护 | 子 agent 的 `excludeTools: ["spawn_agent"]` 禁止递归创建 |
| 工具白名单 | 子 agent 只能使用 agent 配置中声明的 tools。空数组 = 零工具，不会回退 |
| 模型隔离 | 子 agent 使用 agent 配置的 model，解析失败在 spawn_agent 返回明确错误，不回退 |
| 认证隔离 | 父和子共用 `~/.pi/agent/auth.json`，不通过 IPC 传递凭证 |
| 超时保护 | `JsonRpcPeer` 内置请求级超时 + `SubagentRuntime` 全局超时（默认 120s），双重保障 |
| 并发上限 | 默认最多 5 个并行子 agent |
| 优雅终止 | abort 先发 `agent/cancel` 通知，3s grace 后才 SIGTERM → SIGKILL |
| 幂等终态 | finalize 保证 Promise 只 resolve/reject 一次 |
| Worker 退出 | `setImmediate(() => process.disconnect())` 确保响应先发送再断开 IPC |
