# oh-my-pi Subagent 执行深度解析

> 2026-07-09 | 基于源码 `packages/coding-agent/src/task/`

## 1. 一句话总结本质

oh-my-pi 的 subagent **不是进程，不是线程，只是一个新的 `AgentSession` 对象**。它和主 agent 运行在同一个 Node.js 进程、同一个事件循环中。所谓"生成子代理"，本质上就是 `createAgentSession(options)` 然后 `session.run()`。

---

## 2. 完整调用链

```
用户/主 agent 调用
  task({ agent: "explore", assignment: "分析这个项目结构" })
    │
    ▼
TaskTool.execute()
  │ 1. 验证参数 (validateSpawnParams)
  │ 2. 解析 agent 定义 (getAgent)
  │ 3. 解析 spawn-policy (resolveSpawnPolicy)
  │ 4. 检查深度限制 (canSpawnAtDepth)
  │
  ├── 异步路径 (async.enabled=true, agent.blocking≠true)
  │     └── #registerSpawnJob() → AsyncJobManager.register()
  │           └── 内部调用 #executeSync() [同下]
  │
  └── 同步路径
        └── #runSpawn()
              │
              ▼
            executor.runSubprocess({
              agent,        // AgentDefinition (name, systemPrompt, tools, spawns, model...)
              task,         // 渲染后的 prompt (subagent-system-prompt 模板)
              id,           // 唯一 agentId (形如 "gentle-frost-7xq3")
              cwd,
              settings,     // 父会话的 Settings 引用
              modelRegistry,// 父会话的 ModelRegistry 引用  ← 共享!
              authStorage,  // 父会话的 AuthStorage 引用      ← 共享!
              mcpManager,   // 父会话的 MCPManager 引用        ← 共享!
              signal,       // AbortSignal
              onProgress,   // 进度回调
              ...
            })
              │
              ▼
            createAgentSession({        ← 关键! 创建新的 AgentSession
              cwd: worktree ?? cwd,
              authStorage,              // ← 同一个引用
              modelRegistry,            // ← 同一个引用
              settings: subagentSettings,// ← 基于父 settings 的子 settings
              model,                    // ← 子代理的模型配置
              thinkingLevel,
              toolNames: agent.tools,   // ← 子代理自己的 tools 列表
              outputSchema,
              requireYieldTool: true,   // ← 强制注入 yield 工具
              systemPrompt: (defaultPrompt) => {
                // ← 子代理自己的 system prompt
                return [renderedTemplate, ...defaultPrompt]
              },
              agentId: id,
              agentDisplayName,
              spawns: "false",          // ← 默认禁止再 spawn
              taskDepth: childDepth,    // ← 深度 +1
              hasUI: false,             // ← 子代理无 UI
              ...
            })
              │
              ▼
            session.run()               ← 进程内运行推理循环
              │
              │  session 内部循环:
              │    while (not done):
              │      model.generate() → assistant message
              │      如果是 tool_call:
              │        执行工具 (read/write/bash/...)
              │        将 tool_result 加入消息历史
              │      如果是 yield:
              │        提取结构化结果 → 返回
              │
              ▼
            yield 协议结果
              │
              ▼
            组装 SingleResult {
              exitCode, output, stderr,
              usage, tokens, requests,
              durationMs, extractedToolData,
              ...
            }
```

---

## 3. 核心机制详解

### 3.1 AgentSession = Subagent

子代理的本质就是一个**配置不同的 `AgentSession` 实例**。与主 agent 的 AgentSession 相比：

| 属性 | 主 AgentSession | 子 AgentSession |
|------|----------------|-----------------|
| `tools` | 主 agent 的 tools 列表 | 子代理定义中的 tools 列表 |
| `systemPrompt` | 主 agent 的 system prompt | subagent-system-prompt 模板渲染结果 |
| `model` | 主 agent 的模型 | 子代理的模型 (可不同) |
| `settings` | 原始 settings | 继承 + 覆盖的子 settings |
| `hasUI` | true | **false** |
| `spawns` | 主 agent 的 spawns | **"false"** (默认不能再 spawn) |
| `taskDepth` | 0 | parentDepth + 1 |
| `agentId` | "Main" | 生成的唯一 id |
| `authStorage` | ✅ | ✅ (同一引用) |
| `modelRegistry` | ✅ | ✅ (同一引用) |
| `mcpManager` | ✅ | ✅ (同一引用) |

### 3.2 共享 vs 隔离

**共享的（零拷贝，同一个对象引用）**:
- `authStorage` — 认证凭据，不需要重新登录
- `modelRegistry` — 模型列表，不需要重新扫描
- `mcpManager` — MCP 连接，不需要重新建立
- `settings`（基础） — 继承父 settings，子代理可以覆盖

**隔离的（每个子代理独立）**:
- `systemPrompt` — 完全不同的系统提示词
- `tools` — 完全不同的工具列表
- `model` — 可以不同的模型
- `agentId` — 唯一标识
- `sessionManager` — 独立的会话文件 (JSONL)
- `message history` — 独立的对话历史

### 3.3 systemPrompt 模板

子代理的 system prompt 是通过 `subagent-system-prompt.md` 模板渲染的：

```markdown
ROLE
====
{agent.systemPrompt}          ← 子代理定义中的 system prompt

{role}                        ← 可选的角色描述 (如 "Auth-flow security reviewer")

CONTEXT
====
{params.context}              ← task 调用时传入的共享上下文

PLAN
====
{planReference}               ← 主 agent 的已批准计划

COOP
====
{worktree}                    ← 隔离工作树路径
{ircPeers}                    ← IRC 对等方信息

COMPLETION
====
yield 协议说明...             ← 告诉子代理如何回传结果
{outputSchema}                ← 结构化输出 schema
```

这不是"继承父会话历史"，而是**精选结构化上下文 + 子代理自己的 system prompt 拼接**。

### 3.4 yield 协议

子代理没有 `subagent`/`task` 工具（因为 `spawns: "false"`），也没有对话能力（因为 `hasUI: false`）。它唯一的输出方式是 `yield`：

```typescript
// 终端文本结果
yield({ result: { type: "report", data: "项目包含 3 个模块..." } })

// 结构化 JSON 结果
yield({ result: { data: { modules: 3, language: "TypeScript" } } })

// 增量输出 (type 是数组)
yield({ result: { type: ["section1"], data: "..." } })

// 错误
yield({ result: { error: "无法分析: 缺少 package.json" } })
```

`yield` 是子代理的**唯一出口**——它不能直接回复用户，不能调用 `task` 生成子代理（除非 `spawns` 允许），只能产出结构化结果返回给父 agent。

### 3.5 spawn-policy 递归控制

递归控制不是全局深度参数，而是**每个 agent 自声明**：

```
task (主 agent)
  spawns: "explore,plan,designer"
  → 可以生成 explore / plan / designer

explore
  spawns: false
  → 不能再生成任何子代理

designer
  spawns: "reviewer"
  → 可以生成 reviewer

reviewer
  spawns: false
  → 不能再生成任何子代理
```

实现代码：

```typescript
// executor.ts 中创建 AgentSession 时
spawns: spawnsEnv  // 子 agent 定义中的 spawns 值

// 如果 spawns 是 false，子代理不会有 task 工具
// 如果 spawns 是 "reviewer"，子代理的 task 工具只能选 reviewer
```

### 3.6 并发控制

同一时刻可以运行多个子代理（通过 `task.batch` 或多个 `task()` 调用），并发由 `Semaphore` 控制：

```typescript
// task/index.ts
#getSpawnSemaphore(): Semaphore {
  const max = this.session.settings.get("task.maxConcurrency");
  // 所有并行 task 调用共享同一个 Semaphore
  // resize() 支持运行时动态调整限制
}

// 每个 spawn 执行前:
await semaphore.acquire(runSignal)
try {
  await runSubprocess(...)
} finally {
  semaphore.release()
}
```

### 3.7 异步执行 (AsyncJobManager)

当 `async.enabled=true` 且 agent 不是 `blocking: true` 时：

```
task({ agent: "explore", assignment: "..." })
  │
  ├── 立即返回: "Spawned agent gentle-frost-7xq3 (job abc123)"
  │     └── 父 agent 继续执行，不等待
  │
  └── 后台: AsyncJobManager.register("task", agentId, async () => {
        // 这个函数在后台运行
        semaphore.acquire()
        runSubprocess(...)
        // 完成后通过 reportProgress + onUpdate 通知父会话
      })
```

- job 被 Promise + AbortController 管理
- 父 agent 可以通过 `job poll` 等待，通过 `job cancel` 取消
- 完成后自动通过事件系统通知父会话的 UI

---

## 4. 与 "主 agent 只有 task 工具" 架构的关系

这个执行模型天然支持你要的架构：

```
主 agent:
  tools: ["task"]                    ← 只有 task 工具
  systemPrompt: "你是总协调者, 接收任务后分发给子代理..."
  spawns: "*"                        ← 可以生成任意子代理

explore agent (.omp/agents/explore.md):
  tools: ["read","grep","glob","web_search"]
  systemPrompt: "你是代码探索者, 分析代码结构..."
  spawns: false                      ← 不能再生成子代理

designer agent (.omp/agents/designer.md):
  tools: ["read","write","bash"]
  systemPrompt: "你是实现者, 编写和修改代码..."
  spawns: "reviewer"                 ← 可以生成 reviewer
```

工作流：

```
用户: "给项目加一个登录页面"
  │
  ▼
主 agent (只有 task 工具)
  │  task({ agent: "explore", assignment: "分析项目结构和路由" })
  │    └→ explore AgentSession: read/grep → yield 项目结构分析
  │
  │  task({ agent: "designer", assignment: "创建登录页面组件" })
  │    └→ designer AgentSession: write/read/bash → yield 完成的文件列表
  │      └→ (designer 内部) task({ agent: "reviewer", assignment: "审查代码" })
  │            └→ reviewer AgentSession: read → yield review 结果
  │
  ▼
主 agent 汇总结果返回给用户
```

整个过程中：
- **没有进程启动**：每次 `task()` 只是 `createAgentSession()` + `session.run()`
- **工具严格分离**：explore 不能 write，designer 可以 write，reviewer 只能 read
- **递归可控**：explore `spawns: false`，不会无限递归

---

## 5. 与 pi-subagents 的本质差异总结

```
pi-subagents:
  task → spawn("pi", args) → 新进程 → 新 Pi AgentSession → stdout JSONL 流
  本质: 进程间通信 (IPC)

oh-my-pi:
  task → createAgentSession(options) → 新 AgentSession 对象 → session.run()
  本质: 对象创建 + 方法调用 (同进程)
```

| | spawn 进程 | createAgentSession |
|---|---|---|
| 创建开销 | ~200-500ms (Node 启动) | ~0ms (对象分配) |
| 内存开销 | 独立 V8 堆 (~50MB+) | 共享堆 (几 KB) |
| 认证 | 重新加载 | 共享引用 |
| 隔离 | 完全隔离 | 逻辑隔离 |
| 崩溃影响 | 不影响父进程 | 可能影响（未捕获异常） |
| 调试 | 需要 attach 到子进程 | 同进程，直接断点 |
