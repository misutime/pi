# pi Task Tool MVP 开发计划

日期：2026-07-09

结论：`task` tool 需要开发，而且应该作为 subagent MVP 的入口层开发。它不应该一开始承载完整 OMP 功能，而应该先做成一个很薄、可测试、可失败判定的 core tool：接收一个 agent 名和一段任务，创建一个 headless child session，等待 child 完成，解析 `SUBAGENT_RESULT`，把结果返回给 parent agent。

## 1. 定位

`task` tool 的职责：

- 让 parent agent 可以调用指定 subagent。
- 找到 agent definition。
- 检查工具权限和基础安全策略。
- 创建 child session。
- 调用 subagent executor。
- 把 child 的最终结果返回给 parent agent。

`task` tool 不负责：

- 直接执行模型循环细节。
- 解析 child assistant messages 的全部语义。
- 写入文件或修改代码。
- 做 schema validation。
- 做 async job lifecycle。
- 保留 child session。
- 管理 MCP/LSP forwarding。

推荐边界：

```text
TaskTool
  -> resolve agent
  -> validate request
  -> build child run options
  -> call SubagentExecutor
  -> format tool result

SubagentExecutor
  -> create child session
  -> prompt child
  -> collect events
  -> parse final assistant protocol
  -> dispose child
```

## 2. MVP 范围

MVP 只支持 single task：

```json
{
  "agent": "scout",
  "task": "Inspect package.json and summarize the project scripts."
}
```

MVP 支持：

- core 内置工具名：`task`。
- user-level agents。
- single child session。
- headless child surface。
- in-memory child session。
- agent-level tool allowlist。
- optional agent-level model override。
- final assistant protocol：`SUBAGENT_RESULT`。
- missing-result reminder 一次。
- parent abort -> child abort。
- child result 返回给 parent agent。

MVP 不支持：

- `parallel`。
- `chain`。
- project agents。
- nested task。
- `spawns` 配置或 allowlist。
- output schema。
- `yield`。
- async/background job。
- child keep-alive。
- child transcript persistence。
- MCP/LSP forwarding。
- isolated worktree。
- compatibility alias `subagent`。

## 3. Tool 输入 Schema

MVP schema 应尽量小：

```ts
interface TaskToolInput {
  agent: string;
  task: string;
}
```

字段说明：

- `agent`：必填。要调用的 agent name。
- `task`：必填。给 child agent 的任务描述。

暂不加入：

- `tasks`。
- `chain`。
- `context`。
- `role`。
- `cwd`。
- `agentScope`。
- `model` override。
- `timeout`。
- `outputSchema`。

原因：MVP 先验证 core 运行路径。输入越小，模型越容易正确调用，测试也更稳定。agent 级模型放在 agent markdown frontmatter，不放在每次 tool call input 里。

## 4. Tool 输出 Contract

`task` tool 返回给 parent agent 的结果应是普通 tool result 文本，但内部有 typed result。

内部结果建议：

```ts
type TaskToolStatus =
  | "success"
  | "failure"
  | "protocol_failure"
  | "aborted"
  | "agent_not_found"
  | "invalid_request";

interface TaskToolResult {
  status: TaskToolStatus;
  agent: string;
  summary: string;
  details: string;
  rawFinalAssistantText?: string;
  usage?: UsageSummary;
  toolCalls?: ToolCallSummary[];
}
```

返回给模型的文本建议：

```text
Task result from scout
status: success
summary:
<summary>
details:
<details>
```

如果 child 返回 failure：

```text
Task result from scout
status: failure
summary:
<summary>
details:
<details>
```

如果协议失败：

```text
Task result from scout
status: protocol_failure
summary:
The subagent finished but did not return the required SUBAGENT_RESULT format.
details:
<raw final assistant text>
```

## 5. Agent Discovery

MVP 只加载 user-level agents：

```text
getAgentDir()/agents/*.md
```

暂不加载：

- project `.pi/agents/*.md`。
- bundled agents。
- workspace-local generated agents。

原因：

- user-level agents 信任边界更清楚。
- project agents 需要确认 UI 和 trust policy。
- MVP 中 child 固定 headless，不应该在 child 内做确认。

agent markdown 复用当前 example 格式：

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls
model: deepseek-v4-pro
---

You inspect code quickly and return concise evidence.
```

MVP 必需 frontmatter：

- `name`
- `description`

MVP 可选 frontmatter：

- `tools`
- `model`

MVP 暂不处理：

- `thinkingLevel`
- `output`

`model` 是字符串配置。执行前必须通过 pi 现有 model resolver / `modelRegistry` 解析成 `Model<any>`，再传给 `createAgentSession({ model })`。如果解析失败，`task` tool 应返回明确失败，不应静默退回 parent 当前模型。

## 6. 执行流程

MVP 主流程：

```text
TaskTool.execute(input, context)
  1. validate input
  2. load user agents
  3. find input.agent
  4. reject if missing
5. resolve agent tools
  6. resolve optional agent model
  7. build child prompt
  8. call SubagentExecutor.run()
  9. format TaskToolResult
```

`SubagentExecutor.run()`：

```text
1. create SessionManager.inMemory(cwd)
2. create headless child AgentSession
3. subscribe to child events
4. prompt child with task
5. collect final assistant text
6. parse SUBAGENT_RESULT
7. if malformed, send one reminder prompt
8. parse again
9. dispose child session
10. return SubagentRunResult
```

## 7. Child Prompt

MVP prompt 必须把完成协议写清楚。

建议 system prompt：

```text
You are running as a headless subagent.

You must complete the assigned task without asking the user for input.
Use only the tools available to you.

When finished, your final assistant message must use this exact format:

SUBAGENT_RESULT
status: success | failure
summary:
<brief result summary>
details:
<details, evidence, files, risks, or failure reason>

Use status: failure if the task is blocked, unsafe, impossible, or incomplete.
```

user prompt：

```text
AGENT
<agent name>

TASK
<input.task>
```

如果需要加入 agent body：

```text
ROLE INSTRUCTIONS
<agent markdown body>
```

## 8. Final Result Parser

MVP parser 只解析外壳，不理解语义。

输入：

- 最后一条 assistant text。

输出：

```ts
interface ParsedSubagentResult {
  ok: boolean;
  status?: "success" | "failure";
  summary?: string;
  details?: string;
  rawText: string;
  error?: "missing_marker" | "missing_status" | "invalid_status" | "missing_summary";
}
```

解析规则：

- 使用 `lastIndexOf("SUBAGENT_RESULT")` 找 marker。
- marker 后必须有 `status: success` 或 `status: failure`。
- 必须有 `summary:`。
- `details:` 可选，但推荐 prompt 强要求。
- `summary:` 到 `details:` 之间是 summary。
- `details:` 后面全部是 details。
- 不根据自然语言内容判断真假。

## 9. 错误处理

### 9.1 invalid_request

输入缺失或类型错误：

- 不创建 child session。
- 直接返回 `invalid_request`。

### 9.2 agent_not_found

找不到 agent：

- 返回可用 user agent 列表。
- 不 fallback 到默认 agent。

### 9.3 model_not_found

agent frontmatter 指定了 `model` 但无法解析：

- 不创建 child session。
- 返回 `model_not_found` 或 `invalid_agent_model`。
- details 包含原始 model 字符串。
- 不静默 fallback 到 parent 当前模型。

### 9.4 protocol_failure

child 完成但格式不对：

1. 发送一次 reminder。
2. 再次等待 child 回复。
3. 仍格式不对则返回 `protocol_failure`。
4. details 包含 raw final assistant text。

### 9.5 failure

child 按协议返回 `status: failure`：

- `task` tool 自身执行成功。
- 但 task result status 是 `failure`。
- parent agent 可以据此决定是否重试、换 agent、自己处理。

### 9.6 aborted

parent signal abort：

- 调 child abort。
- dispose child。
- 返回 `aborted`。
- 如果已有 partial assistant text，放入 details。

## 10. 工具权限

MVP 工具策略：

- child 只获得 agent `tools` frontmatter 指定的工具。
- 如果 agent 未指定 `tools`，使用保守默认 read-only 工具。
- 推荐默认：`read`、`grep`、`find`、`ls`。
- 不默认给 `bash`、`edit`、`write`。
- `task` 不暴露给 child。

原因：

- MVP 不支持 nested task。
- MVP 不需要 `spawns` 配置；所有 child 都不能继续创建 subagent。
- 默认 read-only 更安全。
- write-capable agent 必须显式 opt in。

## 11. Runtime Metadata

MVP 需要的 metadata：

```ts
runtime: {
  identity: {
    kind: "subagent",
    id: childId,
    parentId,
    displayName: agent.name,
  },
  surface: {
    mode: "headless",
  },
  completion: {
    mode: "assistant-protocol",
    protocol: {
      marker: "SUBAGENT_RESULT",
      missingResult: "remind-then-fail",
      maxReminders: 1,
    },
  },
}
```

作用：

- child 明确是 subagent。
- child 明确无 UI。
- executor 知道如何解析完成结果。

child 不能继续创建 subagent 不需要 metadata 表达。实现规则更直接：创建 child session 时不注册 `task` tool，并且 child tool allowlist 中即使写了 `task` 也忽略。

## 12. 推荐文件

```text
packages/coding-agent/src/core/subagents/
  agents.ts
  executor.ts
  prompt.ts
  result-protocol.ts
  task-tool.ts
  types.ts

packages/coding-agent/src/core/subagents/prompts/
  subagent-system-prompt.md

packages/coding-agent/test/suite/
  subagent-result-protocol.test.ts
  subagent-task-tool.test.ts
```

MVP 暂不需要：

- `spawn-policy.ts`
- `yield-tool.ts`
- `render.ts`
- async job files
- artifact/session files

## 13. 实现顺序

1. 添加 `types.ts`。
2. 添加 `result-protocol.ts` 和 parser 测试。
3. 抽取或移植 user agent discovery 到 `agents.ts`。
4. 添加 agent model resolver helper。
5. 添加 `prompt.ts`。
6. 添加 `executor.ts`，先让测试可直接调用 executor。
7. 添加 `task-tool.ts`。
8. 在 `AgentSession._buildRuntime()` 注册 internal `task` tool。
9. 添加 faux provider 的 task tool 测试。
10. 更新 changelog。
11. 运行 `npm run check`。

建议先让 executor 测试通过，再接入 `AgentSession` tool registry。这样失败点更清楚。

## 14. 测试计划

### 14.1 result protocol parser

覆盖：

- success 格式。
- failure 格式。
- details 多行。
- marker 前有额外文本。
- 缺 marker。
- 缺 status。
- status 非法。
- 缺 summary。

### 14.2 executor

覆盖：

- 创建 headless child session。
- child 不继承 parent message history。
- child 返回合法 success。
- child 返回合法 failure。
- child malformed 后 reminder 成功。
- child malformed 后 reminder 仍失败。
- abort 会 dispose child。

### 14.3 task tool

覆盖：

- input validation。
- agent not found。
- user agent discovery。
- agent model override 解析成功时传给 child session。
- agent model override 解析失败时不创建 child session。
- child tools allowlist。
- 未配置 tools 时使用 read-only default。
- task result 文本包含 status/summary/details。
- parent abort 传递给 child。

## 15. MVP 验收标准

完成后应该能证明：

- parent agent 能调用 `task`。
- `task` 能找到 user-level agent。
- `task` 创建的是进程内 child session，不是 `child_process.spawn`。
- child session 是 in-memory。
- child session 是 headless，`ctx.hasUI === false`。
- child 不继承 parent conversation history。
- child tools 受 agent definition 限制。
- child 用 `SUBAGENT_RESULT` 返回成功/失败。
- malformed result 不会被误判成 success。
- abort 能正确清理 child。
- 相关测试使用 faux provider，不调用真实 API。

## 16. 后续高级功能

这些功能全部放在 MVP 之后，按真实需求逐步加。

### 16.1 Project Agents

- 支持 `.pi/agents/*.md`。
- 需要 parent-side trust confirmation。
- 默认仍建议只启用 user agents。

### 16.2 Parallel

- 支持一次 tool call 运行多个 child。
- 需要 concurrency limit。
- 需要更清晰的 aggregated result。

### 16.3 Chain

- 支持前一个 child 输出作为后一个 child 输入。
- 父 agent 也可以连续调用 `task` 达成，因此优先级低。

### 16.4 Nested Task

- 支持 child 再调用 `task`。
- 需要新的显式 nested-task policy。
- 需要 maxDepth。
- 需要 self-recursion guard。
- 不建议复刻 OMP 的 `spawns` 命名；如果将来需要，设计成更直白的 `nestedTask` / `allowedSubagents`。

### 16.5 Project/User/Bundled Agent Scope

- 支持 `agentScope`。
- 支持 bundled default agents。
- 需要处理同名优先级。

### 16.6 Thinking Level Override

- 支持 `thinkingLevel`。
- 可以后续单独加字段，或复用现有 model pattern 的 `model:thinking` 后缀。
- 需要走现有 thinking level clamp，不要手写 provider/model 兼容逻辑。

### 16.7 Schema Validation

- 支持 typed structured output。
- 应挂在 completion contract 下。
- 不和 MVP final assistant protocol 混在一起。

### 16.8 Optional Yield

- 只有最终文本协议不够可靠时再做。
- 需要 local collector。
- 需要 internal protocol tool activation。
- 需要 missing-yield policy。
- 需要明确和 schema validation 的关系。

### 16.9 Debug Persistence

- 可选保存 child transcript。
- 用于调试，不作为默认行为。

### 16.10 Async Jobs

- 父 agent 不等待 child 完成。
- 需要 job manager、status tool、cancel tool、lifecycle cleanup。
- 不属于 MVP。

### 16.11 Isolated Worktree

- write-capable child 在临时 worktree 中运行。
- 复杂度高，等 write-heavy subagent 需求明确后再做。
