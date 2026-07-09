# pi Subagent 实现计划

日期：2026-07-09

当前决策：同意简化 subagent 设计。pi 第一版借鉴 OMP 的核心理念：同进程 child `AgentSession`、父子 session 隔离、工具受 agent 定义限制。但不照搬 OMP 的 `yield` / `requireYieldTool` / `outputSchema` / `spawns` 这一整套运行时开关。MVP 使用“最后 assistant 文本协议”完成任务返回，并且所有 subagent 都不能继续创建 subagent。

已检查来源：

- `D:\misutime\102_pi\oh-my-pi\docs\omp-subagent-internals.md`
- `D:\misutime\102_pi\oh-my-pi\packages\coding-agent\src\task\`
- `packages/coding-agent/examples/extensions/subagent/`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/tools/index.ts`

## 1. 对 OMP 总结的判断

我同意你的核心判断：OMP 的 subagent 是进程内的新 `AgentSession` 实例，不是 OS 进程，也不是 worker thread。核心路径是 `task` tool -> `runSubprocess()` -> `createAgentSession()` -> 子 session prompt loop，并尽量复用父 session 持有的服务。

当前 pi 的示例 subagent 是相反设计：`packages/coding-agent/examples/extensions/subagent/index.ts` 通过 `child_process.spawn()` 启动独立的 `pi --mode json -p --no-session` 进程，再从 stdout 解析 JSONL 事件。

OMP 总结里准确的点：

- subagent 和主 agent 同进程、同事件循环。
- 每个 subagent 都是独立的 `AgentSession`。
- `authStorage`、`modelRegistry`、settings、MCP manager、prompt/template 上下文，以及部分运行时服务可以从父 session 传入。
- subagent 的工具来自 agent 定义。
- 父 agent 不传完整会话历史，只传渲染后的任务 prompt 和精选结构化上下文。
- OMP 用 `yield` 作为子 agent 的完成协议。
- 递归由 `spawns` 和 `taskDepth` 控制。
- 并发由 semaphore 限制。
- async 执行是 job manager 包装同一套同步执行主体。

需要补充的点：

- `spawns` 不是永远写死为 false。OMP executor 里的 `spawnsEnv` 由子 agent 定义和递归深度决定。
- 父 session 缺失/null/true 的 spawn policy 会解析成 unrestricted `"*"`，但子 agent 自己能否继续 spawn，取决于该子 agent 的 `spawns` frontmatter。
- OMP 的 `yield` 不只是 prompt 约束，还有 `requireYieldTool: true`、自动注入/保留 `yield` 工具、监听成功 `yield`、missing-yield reminder、schema validation/fallback。
- OMP 还有 artifact/session 文件、隔离 worktree、生命周期 registry、IRC/revival、LSP/MCP 转发、输出截断、schema retry/fallback、soft request budget、telemetry 等高级能力。pi 第一版不需要全部搬过来。

## 2. 当前 pi 基线

pi 已有足够基础能力实现 OMP 风格，但不能直接照搬。

可复用能力：

- `packages/coding-agent/src/core/sdk.ts` 里的 `createAgentSession(options)`。
- `AuthStorage` 和 `ModelRegistry` 已经可以传入 child session。
- `SessionManager.inMemory(cwd)` 已存在，并在 SDK examples 里使用。
- `CreateAgentSessionOptions.tools` 已支持工具 allowlist。
- 内置工具是 definition-based，可选择：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。
- `AgentSession.prompt()` 已能驱动 agent loop，并在 queued continuation 完成后 resolve。
- `AgentSession.subscribe()` 可监听 child event，用于进度和输出收集。
- extension 可通过 `pi.registerTool()` 注册工具，支持 `onUpdate`、`ctx.cwd`、`ctx.hasUI`、`ctx.modelRegistry`、abort signal。
- 现有 subagent example 已有 agent discovery、single/parallel/chain 参数形状、TUI renderer、usage 统计、project-agent confirmation。

缺失能力：

- 没有 core 内置 `task` tool。
- 没有可复用的 headless child session factory。
- 没有 final assistant protocol parser。
- 没有 missing-result policy。
- 没有 `agentId`、`agentDisplayName` 这些子代理运行元数据。
- 没有 SDK 级 `hasUI` option；当前 UI 能力来自 extension binding，而不是 session 创建参数。
- `ToolDefinition.execute()` 只能拿到 `ExtensionContext`，拿不到父 `AgentSession`。subagent tool 需要更丰富的上下文，或必须做成 core tool。
- 没有 `src/core` 下的内置 subagent 包；当前只是 example extension。
- 没有 OMP 风格 subagent system prompt template。
- 没有进程内 child lifecycle/progress 聚合层。

## 3. 目标架构

在 pi 里实现一个内置 `task` tool，核心理念类似 OMP，但完成协议更轻。

高层流程：

```text
Main AgentSession
  tool call: task({ agent, task })
    -> TaskTool.execute()
      -> 发现 agent 定义
      -> 创建 child SessionManager.inMemory(cwd)
      -> createChildAgentSession(parent, {
           cwd,
           agent,
           tools: agent.tools,
           runtime: {
             identity,
             completion: assistant-protocol,
             surface: headless,
           },
         })
      -> child.prompt(rendered assignment)
      -> 收集 child events / final assistant text / usage
      -> parse SUBAGENT_RESULT
      -> 缺失协议时提醒一次，仍失败则返回 protocol_failure
      -> dispose child session
      -> 返回结果给父 agent
```

第一版范围：

- 同进程 child session。
- 从 user/project agent markdown 发现 agent。
- single mode 优先。
- 使用 final assistant protocol 作为完成通道。
- 有并发上限。
- child 不允许 nested task；不需要 `spawns` 配置。
- TUI renderer 可复用现有 example 的思路。
- 不做 `yield`、schema validation、async jobs、isolated worktree、IRC、job manager、LSP forwarding、MCP proxying、persistent child revival、telemetry。

## 4. 推荐文件结构

建议做成 core feature，不继续停留在 example extension：

```text
packages/coding-agent/src/core/subagents/
  agents.ts
  executor.ts
  output.ts
  prompt.ts
  render.ts
  result-protocol.ts
  task-tool.ts
  types.ts

packages/coding-agent/src/core/subagents/prompts/
  subagent-system-prompt.md
  subagent-user-prompt.md

packages/coding-agent/test/suite/
  subagent-result-protocol.test.ts
  subagent-task-tool.test.ts
```

备选方案是继续放在 `examples/extensions/subagent`。不推荐：如果目标是“当前 pi 项目也有 subagent 逻辑”，内置支持需要访问父 `AgentSession` 服务；而 extension 的 `ToolDefinition.execute()` 当前只拿到 `ExtensionContext`。

## 5. 公共配置和 Agent 格式

尽量复用现有 agent markdown 格式：

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls
model: deepseek-v4-pro
---

System prompt for this specialist.
```

建议字段：

- `name`：必填。
- `description`：必填。
- `tools`：逗号分隔 allowlist；省略时使用 pi 默认工具。
- `model`：可选 model selector。执行前通过 pi 现有 model resolver / `modelRegistry` 解析成 `Model<any>`，再传给 `createAgentSession({ model })`。
- `blocking`：未来 async 行为字段；phase 1 不生效。
- `output`：phase 2/3 再考虑，MVP 不做 schema。

MVP 不支持 `spawns`。即使 agent markdown 写了该字段，也忽略。child session 永远不暴露 `task` tool。

MVP 不单独支持 `thinkingLevel` frontmatter。若复用现有 model pattern resolver 时解析出 thinking level，可以传给 child；否则 child 使用 parent/settings 的默认 thinking level。无效 `model` 应让 task result 失败，不应静默 fallback。

发现顺序：

- 用户级 agents：`getAgentDir()/agents/*.md`。
- 项目级 agents：最近的 `.pi/agents/*.md`。
- bundled agents 可后续加入。

同名优先级：

- `agentScope: "both"` 时，project agent 覆盖 user agent，和当前 example 一致。
- 默认 scope 应保持 `"user"`，更安全。

## 6. SDK 和 Session 调整

### 6.1 让 built-in tool 能访问父 session

当前 custom/extension tools 拿到的是 `ExtensionContext`，不是 `AgentSession`。内置 `TaskTool` 应该在 `AgentSession._buildRuntime()` 内创建，并能访问：

- `this`
- `this.modelRegistry`
- `this.settingsManager`
- `this.sessionManager`
- `this._resourceLoader`
- `this._cwd`

### 6.2 用 Runtime Contract 替代 option pile

不建议直接复制 OMP 这种松散 option：

```ts
outputSchema?: unknown;
requireYieldTool?: boolean;
hasUI?: boolean;
```

更推荐一个统一 runtime contract：

```ts
interface AgentSessionRuntimeOptions {
  identity?: AgentIdentityOptions;
  completion?: CompletionContract;
  surface?: SessionSurfaceOptions;
}

interface AgentIdentityOptions {
  id: string;
  displayName?: string;
  parentId?: string;
  kind: "main" | "subagent";
}

interface CompletionContract {
  mode: "assistant-protocol" | "assistant-text";
  protocol?: FinalAssistantProtocol;
}

interface FinalAssistantProtocol {
  marker: "SUBAGENT_RESULT";
  missingResult: "remind-then-fail" | "fail";
  maxReminders: number;
}

interface SessionSurfaceOptions {
  mode: "interactive" | "rpc" | "json" | "print" | "headless";
}
```

`createAgentSession()` 可以接收内部 `runtime?: AgentSessionRuntimeOptions`，或者只提供内部 helper：

```ts
createSubagentSession(parent: AgentSession, options: CreateSubagentSessionOptions)
```

推荐先做 helper，减少 public SDK 暴露。

### 6.3 OMP 缺失选项的推荐映射

`spawns`

- MVP 不实现。
- 不在 agent frontmatter 中支持。
- 不在 session runtime 中支持。
- child session 不注册 `task` tool。
- child tool allowlist 中即使写了 `task` 也过滤掉。
- 如果未来确实需要 nested task，再设计新名字，例如 `nestedTask` / `allowedSubagents`，不要直接照搬 OMP 的 `spawns`。

`taskDepth`

- MVP 不需要。
- 因为 child 没有 `task` tool，不存在递归入口。
- 未来如果加入 nested task，再同时加入 depth/maxDepth/self-recursion guard。

`outputSchema`

- MVP 不做。
- 未来如果需要，挂到 `completion` 下，而不是独立裸 option。
- 只有明确启用 structured output 时才 validate。

`requireYieldTool`

- MVP 删除。
- 如果未来引入 `completion.mode = "yield"`，从 mode 推导是否激活 `yield`，不暴露单独 boolean。

`hasUI`

- 不加裸 SDK option。
- pi 已经通过 extension binding 表达 UI：`bindExtensions({ mode, uiContext })`。
- child subagent 固定 `surface.mode = "headless"`，无 UI context。
- `hasUI` 不是 subagent 界面功能，只是告诉工具/扩展当前是否有交互式 UI API。
- pi subagent 里 `ctx.hasUI` 应始终为 false。
- project-agent confirmation 应在父 `task` tool 创建 child 前完成。

推荐第一版 runtime：

```ts
const runtime: AgentSessionRuntimeOptions = {
  identity: { id, displayName, parentId: parent.getAgentId(), kind: "subagent" },
  completion: {
    mode: "assistant-protocol",
    protocol: {
      marker: "SUBAGENT_RESULT",
      missingResult: "remind-then-fail",
      maxReminders: 1,
    },
  },
  surface: { mode: "headless" },
};
```

## 7. Task Tool API

尽量保留当前 example 的调用形状，减少迁移成本。

Single：

```json
{ "agent": "scout", "task": "Find auth code" }
```

Parallel：

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find model code" },
    { "agent": "scout", "task": "Find provider code" }
  ]
}
```

Chain：

```json
{
  "chain": [
    { "agent": "scout", "task": "Find auth code" },
    { "agent": "planner", "task": "Plan changes from: {previous}" }
  ]
}
```

可加 OMP 风格 alias：

- `assignment` 作为 `task` alias。
- `context` 表达 parallel/batch 共享上下文。
- `role` 表达本次 child run 的临时专家身份。

phase 1 不应破坏现有 example schema。

## 8. 执行细节

### 8.1 Child Session 创建

`executor.ts` 创建 child 时建议使用：

- `SessionManager.inMemory(cwd)`。
- 父 `modelRegistry`。
- 通过 `modelRegistry.authStorage` 间接共享父 `authStorage`。
- 初期复用父 `settingsManager`。
- 默认同一 `cwd`，除非任务项显式指定。
- 如果 agent 配置了 `model`，解析后传入 child `createAgentSession()`。
- `tools: agent.tools`。
- 一个能应用动态 subagent system prompt 的 `resourceLoader`。
- `surface.mode = "headless"`。
- `completion.mode = "assistant-protocol"`。
- 不注册 `task` tool。

pi 当前 `buildSystemPrompt()` 从 `ResourceLoader` 读取 `customPrompt`。最简单实现是做一个 `SubagentResourceLoader` wrapper，包住 parent/default loader，并将 child system prompt 作为 custom prompt 或 append prompt 返回。

### 8.2 Prompting

使用 subagent 专属 system prompt 和简单 user prompt：

```text
ROLE
<agent.systemPrompt>

CONTEXT
<optional shared context>

TASK
<assignment>

COMPLETION
When your work is done, your final assistant message must use exactly this format:

SUBAGENT_RESULT
status: success | failure
summary:
<brief summary>
details:
<details, evidence, files, risks, or failure reason>

Do not ask the user for input. If blocked, return status: failure.
```

然后调用：

```ts
await childSession.prompt(renderSubagentUserPrompt(task), {
  expandPromptTemplates: false,
  source: "subagent",
});
```

如果 `source` 类型当前不支持 `"subagent"`，可扩展 `InputSource`，或使用现有最接近的 `"api"`。

### 8.3 Completion

phase 1 只支持 final assistant protocol：

- child run 完成后，读取最后 assistant text。
- 调 `parseFinalAssistantResult(text)`。
- 如果 `status = success`，task tool 返回成功。
- 如果 `status = failure`，task tool 返回失败，但保留 child details。
- 如果 marker/status/summary 缺失，最多提醒一次。
- 第二次仍 malformed，返回 `protocol_failure`。

不做：

- `yield` tool。
- schema validation。
- 模型二次总结。
- 自动把 malformed result 当 success。

### 8.4 Progress

监听 child events：

- `message_end` assistant：收集 text、usage、stop reason。
- `tool_execution_start/end`：收集最近 tool calls。
- `agent_end`：标记 completed/failed。

`onUpdate` 可尽量沿用当前 example 的 `SubagentDetails` shape。

### 8.5 Abort

父 tool 的 `signal` 要传给 child：

- 父 signal abort 时调用 `childSession.abort()`。
- `finally` 中一定 dispose child。
- 若已有 partial output，返回 aborted result。

### 8.6 Concurrency

第一版沿用当前 example 常量：

- `MAX_PARALLEL_TASKS = 8`
- `MAX_CONCURRENCY = 4`

后续再变成 settings：

- `subagent.maxParallelTasks`
- `subagent.maxConcurrency`
- `subagent.enabled`

## 9. Nested Task 策略

MVP 不实现 nested task，也不需要 `spawns` 配置。

规则：

- parent session 可以注册 `task` tool。
- child session 永远不注册 `task` tool。
- agent frontmatter 中的 `spawns` 字段忽略。
- agent `tools` 中即使写了 `task`，child tool resolver 也过滤掉。
- 不需要 `taskDepth` 或 `maxDepth`。

如果未来需要 nested task，再单独设计：

- `nestedTask` 或 `allowedSubagents`。
- maxDepth。
- self-recursion guard。
- parent/child tool exposure tests。
- 明确的 UI/日志展示。

## 10. Tool 注册策略

推荐：

- 添加 `createTaskTool(session: AgentSession): ToolDefinition`。
- 在 `AgentSession._buildRuntime()` 中将 `task` 注册为 internal tool definition。
- extension tools 保持独立。

不建议第一版添加 `yield` tool：

- 它需要额外的 internal protocol tool activation。
- 需要 collector 和 missing-yield retry。
- 会把 output schema/fallback/终止语义提前拉进 MVP。
- 最终 assistant protocol 已足够覆盖 success/failure/summary/details。

不建议只做 extension：

- extension context 不暴露 `settingsManager`、当前 session object、resource loader、safe child-session creation hooks。
- 共享父服务和 child tool exposure 属于 core runtime 行为。
- 内置工具可以更自然参与 active tool filtering 和 system prompt construction。

## 11. 渲染

可复用 `packages/coding-agent/examples/extensions/subagent/index.ts` 的思路：

- `formatUsageStats`
- `formatToolCall`
- single/parallel/chain result view
- collapsed/expanded rendering

需要调整：

- 用 in-process result status 替代 process `exitCode` 语义。
- 移除 stdout/stderr parsing 假设。
- 用 parsed final assistant protocol 展示 status/summary/details。
- `Message[]` 改成 `AgentMessage[]` 或 compact display item list。

## 12. 测试

使用 `packages/coding-agent/test/suite/harness.ts` 和 faux provider，不调用真实 provider API。

核心测试：

1. `subagent-result-protocol.test.ts`
   - 能解析合法 `SUBAGENT_RESULT` success。
   - 能解析合法 failure。
   - 缺 marker 返回 `missing_marker`。
   - 缺 status 返回 `missing_status`。
   - 非法 status 返回 `invalid_status`。
   - 缺 summary 返回 `missing_summary`。

2. `subagent-task-tool.test.ts`
   - single agent 创建 in-memory child session。
   - child 只拿到选定工具。
   - 复用 parent model registry。
   - agent model override 解析成功时 child 使用该 model。
   - agent model override 解析失败时返回明确失败。
   - child final assistant protocol success 会返回成功。
   - child final assistant protocol failure 会返回失败。
   - child malformed result 会触发一次 reminder。
   - reminder 后仍 malformed 会返回 protocol failure。
   - abort 返回 partial output。
   - `agentScope` 包含 project 且 `ctx.hasUI` 为 true 时，需要 project agent confirmation。

3. 后续发现 bug 后，在 `packages/coding-agent/test/suite/regressions/` 加 regression。

手动 smoke：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "Use a scout subagent to inspect package.json" Enter
tmux capture-pane -t pi-test -p
tmux kill-session -t pi-test
```

代码改动后运行：

```bash
npm run check
```

除非用户明确要求，不运行 `npm test` 或 full vitest。

## 13. 分阶段计划

### Phase 0：抽取现有 example 的可复用部分

- 将 agent discovery 从 example 抽到 `src/core/subagents/agents.ts`。
- 将共享 result types 抽到 `types.ts`。
- 暂时保留 process-spawn example 可用。
- 添加 discovery/frontmatter parsing 测试。

### Phase 1：最终文本协议和进程内 single subagent

- 实现 `result-protocol.ts`。
- 实现单 child session 的 `executor.ts`。
- 添加 single mode internal `task` tool。
- 添加 child event collection。
- 使用 in-memory child session。
- 可靠 dispose child。
- 缺失协议时提醒一次。
- 用 faux provider 测试。

### Phase 2：Parallel 和 Chain

- 移植 `mapWithConcurrencyLimit`。
- 添加 parallel 和 chain schema。
- 复用现有 renderer。
- 添加 parallel children 的 abort propagation。
- 添加 parent-visible output truncation。

### Phase 3：可选 Nested Task

默认不做。只有真实需求出现后再设计：

- 显式 nested-task policy。
- max-depth 设置。
- self-recursion guard。
- child tool exposure tests。

### Phase 4：Project Agents 和安全策略

- 默认 `agentScope: "user"`。
- UI 模式下对 project agents 添加确认。
- 工具描述中明确 project agents 是 repo-controlled prompts。
- 确保 child cwd 不会因 malformed cwd 意外逃逸，除非显式指定。

### Phase 5：可选结构化输出

- 如果 final assistant protocol 不够，再考虑 schema validation。
- schema 应挂在 `completion` contract 下。
- schema failure 应作为 task result failure，而不是静默修复。

### Phase 6：可选 yield

只有出现明确需求时再做：

- child 经常不遵守最终文本协议。
- 需要 tool-call 级终止信号。
- 需要 strongly typed payload。
- 需要 incremental result。

届时再添加：

- `yield-tool.ts`。
- local collector。
- protocol tool activation。
- missing-yield policy。
- schema validation/retry。

### Phase 7：可选 OMP 高级功能

核心路径稳定后再考虑：

- async jobs。
- persistent child session artifacts。
- child session revival。
- isolated worktrees。
- MCP forwarding/proxy tools。
- LSP forwarding。
- telemetry。
- agent registry / peer coordination。

## 14. 风险

- Tool context access：当前 extension API 不够；做成 core 可避免不自然泄漏。
- Final protocol compliance：模型可能忘记 `SUBAGENT_RESULT`。用 prompt + 一次 reminder + malformed failure 处理。
- Prompt construction：pi 的 `ResourceLoader` 偏文件/config，不偏动态 per-child prompt。wrapper 比修改 parent resources 更干净。
- Recursive task exposure：MVP 通过 child 不注册 `task` tool 彻底关闭递归入口。
- Session persistence：`SessionManager.inMemory()` 不产生文件，少 churn，但调试难。可后续加 debug artifact。
- Example compatibility：如果替换 example，docs 要明确旧 subprocess isolation 不再是默认实现。

## 15. 待决问题

- 内置工具命名用 OMP 的 `task`，还是当前 example 的 `subagent`？
- 是否完整保留当前 example 的 `agent/task/tasks/chain` schema？
- project agents 是否只允许通过显式 `agentScope` 开启？
- phase 1 是否允许 write-capable agents，还是先只允许 read-only？
- child session 是否自动继承 parent prompt templates/skills/context files？

推荐答案：

- 内部 canonical name 用 `task`，可后续把 `subagent` 做 alias。
- 保留当前 example schema，并添加 `assignment` alias。
- project agents 必须显式 `agentScope`。
- write-capable agents 可允许，但必须由 agent definition 显式 opt into write tools。
- prompt templates/skills 只有便宜且安全时才继承；绝不继承 parent message history。

## 16. 非核心功能决策列表

这张表用于实现前裁剪范围。我的默认推荐是 phase 1 保持小：同进程 child session、严格工具隔离、最终 assistant 文本协议、有并发上限、无 child UI。

| 项目 | 作用 | 推荐 | 决策 |
|------|------|------|------|
| 内置工具 alias `subagent` | 允许用户同时调用 `task` 和 `subagent` | 推迟。第一版只用 `task`，减少 prompt/tool 混淆。 | TBD |
| Parallel mode | 一个 tool call 里运行多个 child agent | 如果 multi-agent fanout 是核心目标则保留；否则 single 稳定后再做。 | TBD |
| Chain mode | 将前一个 child 输出喂给下一个 child | 推迟。父 agent 可以连续调用 `task` 达成。 | TBD |
| `agentScope: "project"` | 从 repo 的 `.pi/agents/*.md` 加载 agents | 只在显式参数和父侧确认后保留。 | TBD |
| User-level agents | 从用户配置目录加载 agents | 保留。比 project agents 更适合作默认。 | TBD |
| Bundled default agents | 内置 scout/planner/reviewer 等 | 推迟，除非希望开箱即有完整 workflow。 | TBD |
| Agent `role` 参数 | 给一次 child run 临时专家身份 | 保留。价值高、复杂度低。 | TBD |
| 自定义 child `cwd` | 让 child 在另一个 cwd 下运行 | 推迟或限制。phase 1 用当前项目 cwd 足够。 | TBD |
| Child JSONL persistence | 保存 child transcript 便于调试 | 推迟。先用 in-memory child session。 | TBD |
| Debug artifact directory | 单独保存 child outputs/logs | 推迟。只有 in-memory 调试痛苦时再加。 | TBD |
| Async/background jobs | 父 agent 不等待 child 完成 | phase 1 删除。需要 job manager 和复杂 lifecycle。 | TBD |
| Child keep-alive/revival | 完成后的 child 仍可寻址 | 删除。默认 dispose child session。 | TBD |
| IRC/peer coordination | child agents 互相发消息 | 删除。干净第一版不需要。 | TBD |
| Isolated worktrees | write-capable child 在临时 branch/worktree 运行 | 推迟。有价值但很大。 | TBD |
| MCP forwarding | child 使用 parent MCP servers/tools | 推迟。第一版只用 pi 内置工具。 | TBD |
| LSP forwarding | child 获得语言服务器工具/上下文 | 推迟。phase 1 不需要。 | TBD |
| Telemetry handoff | 串起 parent/child spans | 推迟，除非发布要求 observability。 | TBD |
| Schema output validation | 校验 child structured output | 推迟。final assistant protocol 先跑真实使用。 | TBD |
| `yield` tool | 用 tool call 作为强完成信号 | 推迟到 P3。MVP 不做。 | TBD |
| Incremental yield sections | child 产出 labelled partial sections | 删除。terminal result 足够第一版。 | TBD |
| Missing-result reminder | protocol failure 前提醒 child 改格式 | 保留一次。 | TBD |
| Free assistant fallback | 完全无协议时当普通文本返回 | 不推荐。应失败并带 raw output。 | TBD |
| Soft request budget | child turn 太多时提醒/中止 | 推迟，等真实使用暴露需求。 | TBD |
| Agent 级 model override | agent frontmatter 可指定 model | 保留。createAgentSession 已支持 Model；只需用现有 resolver 把字符串解析成 Model。 | TBD |
| Agent 级 thinking level | agent frontmatter 可指定 thinking level | 除非保留 model override，否则推迟。 | TBD |
| Child 继承 skills | child 可看到 parent/user skills | 推迟或 allowlist。先避免隐藏 prompt 膨胀。 | TBD |
| Child 继承 prompt templates | child 可展开 slash prompt templates | phase 1 删除。child 应收到直接 assignment。 | TBD |
| Child 继承 context files | child 收到 AGENTS/context files | 只保留 base prompt 已包含的项目规则；不继承父会话。 | TBD |
| Task feature setting flag | 全局/项目级启停内置 task tool | 保留。重要安全开关。 | TBD |
| Max concurrency setting | 可配置 child concurrency | 推迟。先写保守默认值。 | TBD |
| Nested task / max depth | child 继续创建 subagent | 删除出 MVP。以后需要时重新设计，不用 OMP `spawns`。 | TBD |
| Project-agent confirmation override | 允许调用者跳过确认 | 初期删除，避免绕过 trust gate。 | TBD |

推荐最小 MVP：

- 只提供内置 `task`。
- 只做 single subagent mode。
- 默认只加载 user-level agents；project agents 必须显式开启并由父侧确认。
- child session 使用 in-memory。
- child surface 固定 headless。
- child 不能继续创建 subagent；不支持 `spawns`。
- final assistant protocol，加一次 missing-result reminder。
- 不做 `yield`、async jobs、child keep-alive、MCP/LSP forwarding、isolated worktrees、schema validation。

## 17. 实现 Checklist

- 添加 `src/core/subagents/types.ts`。
- 从 example 移动/移植 `agents.ts`。
- 添加 `src/core/subagents/result-protocol.ts`。
- 添加 `src/core/subagents/prompt.ts`。
- 添加 `src/core/subagents/executor.ts`。
- 添加 `src/core/subagents/render.ts`。
- 添加 `src/core/subagents/task-tool.ts`。
- 在 `AgentSession._buildRuntime()` 中接入 task internal tool。
- 按需扩展 `CreateAgentSessionOptions` 或内部 runtime metadata。
- 添加 faux provider 测试。
- 更新 `packages/coding-agent/CHANGELOG.md` 的 `## [Unreleased]`。
- 更新 docs/examples。
- 运行 `npm run check`。

## 18. OMP 设计中 pi 应优化的点

目标不是逐行移植，而是保留 OMP 核心理念，避开让设计难以推理的部分。

### 18.1 用 Runtime Contract 替代 Flag Pile

OMP 通过 `createAgentSession()` 传递很多互相正交的 options：

- `hasUI`
- `outputSchema`
- `requireYieldTool`
- `agentId`
- `agentDisplayName`
- parent state hooks
- artifact/session/MCP/LSP/telemetry options

pi 应按语义分组：

- `identity`
- `completion`
- `surface`
- 可选 `sharedServices`

这样 invalid state 更难表达。例如 MVP 里 `completion.mode = "assistant-protocol"` 明确不需要协议工具；未来若加 `completion.mode = "yield"`，再由 mode 推导 tool activation，不需要单独 `requireYieldTool`。

### 18.2 不实现 OMP 的 Spawns

OMP 的 `spawns` 能力强，但会把递归、深度、allowlist、prompt 描述、工具暴露策略绑在一起。pi MVP 不需要它。

pi 第一版规则更简单：

- parent 可以有 `task`。
- child 没有 `task`。
- agent config 不支持 `spawns`。
- 不需要 `taskDepth`。

如果将来要做 nested task，再设计新的显式 policy，不沿用 OMP 的 `spawns` 名字。

### 18.3 避免子执行依赖全局或 Singleton 状态

OMP 有 agent registry、singleton MCP manager fallback、lifecycle adoption、revival、IRC 等全局式系统。这些对 OMP 的大功能集有用，但会增加耦合。

pi phase 1 应让 child 状态局部化：

- 本地 `ResultProtocolParser`
- 本地 `ProgressCollector`
- 本地 abort controller
- 本地 child session manager
- 不要 global subagent registry
- 不要 parked/idle child revival

### 18.4 明确 Headless Extension Binding

OMP 用 `hasUI: false` 作为 session 创建参数。pi 应复用现有 extension binding model：

- parent mode 绑定 TUI/RPC UI。
- child mode 绑定 headless context。
- project-agent confirmation 在 child 创建前由 parent 完成。

这样 UI authorization 留在 parent，child session 保持确定性。

### 18.5 先不用 Yield

OMP yield assembly 支持 terminal yield、incremental labels、schema override warnings、fallback parsing、null-yield warnings、missing-yield reminders、review finding injection。

pi MVP 不需要这些。第一版只需要：

- final assistant protocol。
- marker/status/summary/details parser。
- 一次 missing-result reminder。
- malformed result 失败。
- raw assistant text 保留。

如果这条路在真实使用中不够可靠，再升级为 optional `yield`。

### 18.6 Schema Validation 放在边界，并且后置

MVP 不做 schema。未来如果做，应在 task 边界只校验一次：

- 收集 final result。
- normalize payload。
- 按 schema validate。
- 返回 success 或 structured schema error。

不要让 prompt、tool、executor 多处各自拥有 schema retry policy。

### 18.7 分离 Progress Data 和 Render Data

OMP progress 很丰富，但混合了执行状态、渲染提示、nested task details、extracted tool data、retry state、billing stats。

pi 应分三类：

- `SubagentRunState`：权威执行状态。
- `SubagentProgressView`：紧凑 UI/model-visible progress。
- `SubagentResult`：最终 tool result details。

renderer 消费 view/result types，不直接消费或修改 runtime object。

### 18.8 默认不要 Keep Alive 已完成子 session

OMP 可以为 IRC/revival 保留 subagent。这很强，但增加内存所有权和生命周期复杂度。

pi 默认 dispose child。可选 debug persistence 后续再加：

- 只有 `subagent.debugSession = true` 时写 child JSONL。
- phase 1 不做 revival。
- phase 1 不做 idle TTL。

### 18.9 不要自动转发父 session 的全部设施

OMP 会转发很多父设施：MCP、LSP、rules、context files、skills、prompt templates、artifact managers、telemetry、memory state、eval state、service tiers。

pi 应使用 allowlist：

- 始终共享：model registry、通过 model registry 间接共享 auth storage、cwd、模型调用需要的 settings。
- 通常可共享：prompt templates 和 skills，但前提是便宜且安全。
- 后续 opt-in：MCP tools、LSP、debug artifacts、telemetry。
- phase 1 不共享：parent conversation history、UI context、live child registry。

### 18.10 并发按 Parent Session 限制

OMP session-scoped semaphore 这个思路值得保留。

pi 应实现：

- 每个 parent `AgentSession` 一个 semaphore。
- 并行 task calls 和一次 call 内的并行 children 共用同一个 semaphore。
- settings 后续可 resize。
- 默认值保守。

### 18.11 Agent Discovery Cache 必须显式

OMP 在 tool creation 时 memoize discovery，执行时 refresh。pi 应先选简单规则：

- phase 1 每次 task invocation 都 fresh discovery。
- 后续再加 filesystem invalidation 或显式 `/reload` cache。

fresh discovery 更简单，也匹配当前 example “session 中途改 agents 也能生效”的行为。

### 18.12 保持内置工具名稳定

OMP 用 `task`；当前 pi example 用 `subagent`。pi 不应让模型同时面对两套主要名称。

推荐：

- canonical built-in tool name：`task`。
- 可选 compatibility alias：`subagent`。
- 同一个 executor。
- docs 推荐 `task`。

## 19. 更好的 pi 目标设计

目标是“OMP idea, pi implementation”：

```text
TaskTool
  负责 policy、confirmation、concurrency、rendering

SubagentExecutor
  负责 child session lifecycle、abort、event collection、completion contract

SubagentSessionFactory
  创建 child AgentSession，复用 model/auth services，并固定 headless surface

ResultProtocolParser
  解析 final assistant text，无全局状态

NestedTaskPolicy
  MVP 不存在；未来需要 nested task 时再加入
```

phase 1 推荐边界：

- `TaskTool` 不直接解析 assistant messages。
- `SubagentExecutor` 不向用户提问。
- `ResultProtocolParser` 不判断内容真假，只判断协议形状。
- `AgentSession` 只知道通用 runtime metadata，不知道 subagent 业务逻辑。
- render code 不修改执行状态。

成功标准：

- 同进程，无 `child_process.spawn`。
- child context 与 parent history 隔离。
- parent services 复用，不重新登录、不重新 refresh model。
- child tools 受 agent definition 限制。
- completion 通过 final assistant protocol 显式完成。
- missing/malformed result 可失败判定。
- child 不能继续创建 subagent。
- 代码路径可用 faux provider 测试，不调用真实 API。
