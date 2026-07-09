# pi-subagents vs oh-my-pi Subagent 设计对比

> 2026-07-09
> oh-my-pi 执行细节见 [omp-subagent-internals.md](./omp-subagent-internals.md)

## 1. 概览对比

| 维度 | pi-subagents (0.34.0) | oh-my-pi |
|------|----------------------|----------|
| 所属生态 | Pi Coding Agent (earendil) | oh-my-pi (Nico Bailon, 同一作者) |
| 本质 | **插件扩展** (extension) | **原生内置** (核心功能) |
| 工具名 | `subagent` | `task` |
| 工具调用风格 | 丰富的扁平参数 (agent/task/chain/tasks/action...) | 简洁的 TaskParams (agent/assignment/role/tasks/context) |
| 架构风格 | 多层插件架构，通过 Pi 事件系统与父会话通信 | 原生嵌入会话生命周期，深度集成 |
| 进程模型 | 每个子代理 = 独立 `spawn(pi)` 子进程 | 每个子代理 = **进程内** `AgentSession` (同线程) |
| 异步支持 | `spawn` 双层包装子进程 | 基于 `AsyncJobManager` 的 Promise 任务队列 |
| 模拟执行 | 不支持 | 支持 (eval `agent()`) |

---

## 2. 详细架构对比

### 2.1 进程模型

这是两者**最根本的差异**。

**pi-subagents — 独立子进程模型**:
```
父 Pi 进程
  └── subagent 工具调用
        └── spawn("pi", ["-p", task]) → 子 Pi 进程
              ├── stdout JSONL 事件流 → 父进程实时解析
              ├── 进程级隔离 (独立 node 运行时)
              └── 进程退出 → 结果回传
```

- 每个子代理是独立 `pi` CLI 进程
- 通过 stdout JSONL 流通信 (`execution.ts` 中的 `processLine()` 函数解析事件)
- 完全进程隔离：内存、文件系统、事件循环均独立
- 父进程通过 `spawn()` 返回的 `ChildProcess` 管理生命周期 (SIGINT/SIGTERM/SIGKILL)
- 异步路径额外包装一个 `subagent-runner` 进程 (双层 spawn)

**oh-my-pi — 进程内执行模型**:
```
父 AgentSession
  └── task 工具调用
        └── AgentSession 工厂 → 新的 AgentSession (同进程，同线程)
              ├── 共享 Api 实例 (model registry, auth)
              ├── 共享 MCPManager
              ├── 通过 AgentRegistry 注册/跟踪
              └── 通过 agentEvents 事件流通知进度
```

- 子代理是进程内的新 `AgentSession` 实例
- 通过 `AgentSession` 的事件系统通信
- 零进程创建开销
- 共享父进程的模型连接、认证、MCP 连接
- 通过 `AsyncJobManager` 管理异步执行 (基于 AbortController + Promise)

### 2.2 代理发现机制

**pi-subagents — 五层发现 + 覆盖**:
```
内置代理 (8个 .md 文件)
  ├── 用户自定义 (~/.pi/agent/agents/*.md)
  ├── 项目自定义 (.pi/agents/*.md)
  ├── 包代理 (node_modules 中 pi-subagents 清单)
  ├── 设置覆盖 (settings.json → agentOverrides)
  └── 动态管理 (create/update/delete/eject/enable/disable/reset)
```
- 多作用域合并 (user/project/both)
- 完整的 CRUD 管理 API
- AgentConfig 包含 20+ 配置字段
- 支持链配置 (.chain.md) 作为一等公民

**oh-my-pi — 三层发现 + spawn 策略**:
```
内置代理 (8个 TypeScript 嵌入定义)
  ├── 用户自定义 (~/.omp/agent/agents/*.md)
  ├── 项目自定义 (.omp/agents/*.md)
  └── 扩展包代理 (OMP extension roots)
```
- 通过 AgentRegistry 跟踪活动代理
- 父代理的 `spawns` frontmatter 控制子代理白名单
- spawn-policy: 可限制子代理只能生成特定类型的孙子代理
- 不支持链配置 (无等价概念)

### 2.3 上下文传递

**pi-subagents**:
- **fresh**: 全新的空会话，只给任务
- **fork**: 从父会话分支，继承完整历史作为 "reference-only" 上下文
- 每个代理可配置默认上下文策略 (`defaultContext: "fork"`)
- fork 时任务被包装: `"You are a delegated subagent...\n\nTask:\n{task}"`

**oh-my-pi**:
- **context 共享**: 通过 `subagent-system-prompt.md` 模板传递
  - `ROLE`: 代理身份 + 角色描述
  - `CONTEXT`: 共享背景 (`params.context`)
  - `PLAN`: 父会话的已批准计划
  - `COOP`: 工作树路径、IRC 对等方信息
  - `COMPLETION`: yield 协议规范
- 不继承父会话历史，而是通过结构化 prompt 模板传递精选上下文
- 支持 `planReference` 将整体计划传递给每个子代理

### 2.4 执行模式

**pi-subagents — 三种模式显式分离**:

| 模式 | 参数 | 并发 |
|------|------|------|
| Single | `agent + task` | 单进程 |
| Parallel | `tasks[]` | 并发 spawn，Semaphore 限流 |
| Chain | `chain[]` | 顺序执行，`{previous}` 模板 |

- Chain 支持: 动态扇出 (dynamic fanout)、命名输出 (`{outputs.name}`)、并行步骤、worktree 隔离
- Chain 步骤追加 (`action: "append-step"`)
- 链的 TUI 预览/确认 (`clarify: true`)

**oh-my-pi — 通过 task.batch 统一**:

| 模式 | 参数 | 并发 |
|------|------|------|
| Single | `agent + assignment` | 单 AgentSession |
| Batch | `agent + context + tasks[]` | 并发 AgentSession，Semaphore 限流 |

- 没有显式的 "chain" 概念
- 通过 `irc` 工具让并发子代理之间协调
- 每个 tasks[] item 可以有独立的 `role`（角色描述）
- `yield` 协议作为子代理向父代理回传结果的标准方式

### 2.5 运行时控制

**pi-subagents — 丰富的运行时控制**:

| 操作 | 说明 |
|------|------|
| `interrupt` | 软中断 → SIGINT → SIGTERM → SIGKILL |
| `resume` | 向暂停的子代理发送跟进消息 |
| `steer` | 向运行中的子代理发送非终结性引导 |
| `append-step` | 向运行中的链追加步骤 |
| turn budget | 硬限制对话轮数 |
| tool budget | 硬限制工具调用数 |
| control notices | 长时间运行/无活动通知 |
| completion guard | 检测空实现的子代理 |

**oh-my-pi — 进程内控制**:

| 操作 | 说明 |
|------|------|
| `job cancel` | 通过 AsyncJobManager 取消异步任务 |
| `job poll` | 轮询异步任务完成 |
| `irc` | 子代理间直接通信协调 |
| 请求预算 | 软件请求数预算 (`SOFT_REQUEST_BUDGET`) |
| 终止回退 | 超过 1.5x 预算硬终止 |
| token 重试 | 内置自动重试机制 |

### 2.6 隔离机制

**pi-subagents**:
- 基于 **git worktree** 的文件系统隔离
- `createWorktrees()` / `cleanupWorktrees()` / `diffWorktrees()`
- 支持 `worktreeSetupHook` 初始化脚本
- 仅用于并行任务，非默认

**oh-my-pi**:
- 基于 **git worktree + branch** 的双模式隔离
- `task.isolation.mode` 配置: `none` / `worktree` / `branch`
- `isolated: true` 参数按任务启用
- 支持自动合并 (merge/cherry-pick)
- 安装隔离能力通过 `natives.IsoBackendKind`
- 也支持嵌套补丁 (`nestedPatches`)

### 2.7 结果交付

**pi-subagents**:
- stdout JSONL 流 → 解析为 `tool_execution_start/end`、`message_end` 等事件
- 结果通过 `AgentToolResult<Details>` 返回
- `Details` 包含所有子任务的 `SingleResult[]`、进度、使用量、链信息
- 支持多种输出模式 (`inline` / `file-only`)
- Intercom 结果传递 (子→父通过事件总线)

**oh-my-pi**:
- 进程内 `AgentSession` 的 `agentEvents` 事件流
- 结果通过 `yield` 协议返回
  - 结构化数据: `yield({ result: { data: {...} } })`
  - 终端文本: `yield({ result: { type: "string" } })` 或省略 type
  - 增量输出: `yield({ result: { type: ["section"] } })` 累积
  - 错误: `yield({ result: { error: "..." } })`
- `Usage` 累积 (输入/输出/cache tokens + 成本)
- 基于 `reportProgress` 的异步进度更新

---

## 3. 设计哲学对比

### pi-subagents — "丰富的编排平台"

1. **进程隔离优先**: 每个子代理是独立进程，天然隔离，崩溃不互相影响
2. **显式的状态机**: 大量类型定义明确表达各种状态（`SubagentState`、`AsyncJobState`、`WorkflowGraphNode` 等）
3. **链式编排**: Chain 作为一等公民，支持复杂的工作流组合
4. **管理 API**: 完整的代理生命周期管理（CRUD、启用/禁用等）
5. **扩展性**: 插件架构，通过 Pi 事件系统与父会话通信
6. **观察性**: 丰富的工件系统（artifacts）、转录记录、状态文件

### oh-my-pi — "精简的原生集成"

1. **进程内优先**: 子代理在进程内运行，零开销，共享资源
2. **simplicity over features**: 参数少而精（`agent`、`assignment`、`role`）
3. **yield 协议**: 统一的结果回传方式，支持结构化、增量、错误
4. **原生集成**: 深度集成会话生命周期，共享认证、模型注册、MCP
5. **irc 协调**: 子代理之间直接通信，替代显式的链式编排
6. **spawn-policy**: 父代理控制子代理可生成什么类型，防止递归失控

---

## 4. 各自优势

### pi-subagents 的优势

| 领域 | 优势 |
|------|------|
| **进程隔离** | 子代理崩溃不影响父进程；完全独立的内存/文件系统空间 |
| **链式编排** | 显式的多步骤工作流、动态扇出、步骤追加、命名输出 |
| **上下文管理** | fresh/fork 双模式、每个代理独立配置 |
| **代理管理** | 完整的 CRUD + 启用/禁用 + 重置，动态管理代理定义 |
| **观察性** | 详细的 artifacts、转录、workflow graph 快照 |
| **运行时控制** | interrupt/resume/steer/append-step 等细粒度操作 |
| **安全边界** | `mcpDirectTools` 白名单、`subagentOnlyExtensions`、completion guard |
| **跨会话** | 可以 resume 历史子代理，恢复会话继续工作 |
| **Turn/Tool Budget** | 硬限制防止子代理失控 |
| **Acceptance Gate** | 六级验证关卡，含自动 verify 命令和 reviewer 子代理 |

### oh-my-pi 的优势

| 领域 | 优势 |
|------|------|
| **性能** | 进程内执行，无 spawn 开销；共享模型连接、认证、MCP 连接 |
| **简洁性** | 参数少、概念少，学习曲线低 |
| **资源效率** | 无额外进程内存开销 |
| **深度集成** | 共享父会话的 model registry、auth、settings、MCP |
| **spawn-policy** | 父代理精确控制子代理可生成什么，链式递归防护更自然 |
| **yield 协议** | 统一的结果回传，支持结构化/增量/终端/错误 |
| **irc 协调** | 并发子代理直接通信，不需要显式编排 |
| **请求预算** | 软限制 + 通知，比硬中断更优雅 |
| **隔离** | worktree + branch 双模式，支持自动合并 |
| **模型覆盖** | `agentModelOverrides` 在 settings 层面控制每个代理的模型 |
| **EVAL 支持** | 支持 eval `agent()` 桥接，方便评估和测试 |
| **Plan 模式** | 子代理可以感知整体计划，与主代理保持一致 |

---

## 5. 关键缺失对比

### pi-subagents 缺失 oh-my-pi 具备的能力

1. **进程内执行**: 每个子代理都是独立进程，增加了延迟和资源消耗
2. **spawn-policy**: 没有父代理控制子代理类型的白名单机制
3. **yield 协议**: 没有标准化的增量结果回传方式
4. **irc 协调**: 子代理之间无法直接通信（需要通过父代理）
5. **请求预算**: 只有硬 turn/tool budget，没有软请求限制
6. **branch 隔离**: 只有 worktree，没有 git branch 模式

### oh-my-pi 缺失 pi-subagents 具备的能力

1. **进程隔离**: 子代理模型崩溃可能影响父会话
2. **Chain**: 没有显式的多步骤串行工作流
3. **fresh/fork 上下文**: 无上下文分支机制
4. **代理管理 API**: 没有动态 CRUD 操作
5. **interrupt/resume/steer**: 运行时控制能力较弱
6. **acceptance gate**: 没有结构化的任务验证关卡
7. **turn/tool 硬预算**: 没有调用的硬限制
8. **详细的工件系统**: 缺少 transcript、workflow graph 等

---

## 6. 综合评价

### 何时 pi-subagents 更好

- 需要**进程隔离**: 子代理运行不可信或高风险任务
- 需要**链式工作流**: 多步骤有依赖关系的任务编排
- 需要**丰富的运行时控制**: interrupt/resume/steer/append-step
- 需要**跨会话持久化**: resume 历史子代理
- 需要**硬预算控制**: 严格控制子代理消耗
- 需要**代理管理 API**: 动态管理代理定义
- 适合**独立插件生态**: 作为 Pi 的扩展运行

### 何时 oh-my-pi 更好

- 需要**高性能**: 大量并发子代理，零进程启动开销
- 需要**简洁性**: 更少的参数和概念
- 需要**深度集成**: 共享 model registry、auth、MCP
- 需要**子代理间协作**: irc 直接通信
- 需要**分支隔离**: git branch 模式的隔离工作
- 需要**模拟/评估**: eval `agent()` 桥接
- 需要**Plan 模式集成**: 子代理感知整体计划
- 适合**原生体验**: 与 oh-my-pi 生态深度融合

---

## 7. 总结

两者都是同一作者 (Nico Bailon) 的作品，代表了**同一理念在不同生态中的两种实现**：

- **pi-subagents** 是"插件化"的思路：作为一个独立的扩展，拥有自己的代理定义系统、自己的工件管理、自己的配置层。它是 *feature-rich* 的，但代价是更大的复杂度和进程开销。

- **oh-my-pi** 的 `task` 工具是"原生集成"的思路：深度嵌入会话生命周期，进程内执行，共享所有基础设施。它是 *lean and fast* 的，但功能范围更窄。

从演进角度看，oh-my-pi 像是 pi-subagents 的"下一代"设计——借鉴了插件版本的经验教训，重新从零构建为原生能力，在性能、简洁性和集成度上做了根本性的架构升级，同时牺牲了部分灵活性（如链式编排、代理管理 API）来换取更好的开箱即用体验。

**如果强制选一个更好的**: 对于 oh-my-pi 生态用户，原生集成的 `task` 工具无疑更好——更快、更简单、更省资源。但如果需要代理管理 API、链式编排、跨会话持久化等高级能力，pi-subagents 是唯一选择。
