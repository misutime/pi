# pi Subagent 前置基础能力清单

日期：2026-07-09

结论：同意先简化。pi 不应该为了第一版 subagent 先实现 OMP 那套 `yield` 协议工具。更稳妥的顺序是先补齐一组通用 runtime 能力，然后用“最后 assistant 文本协议”作为 MVP 的完成通道。这样 subagent 可以先跑通、可测试、可失败判定，同时避免把 OMP 最复杂的一块提前搬进来。

## 1. 总体原则

第一版不要先追求 OMP 级别的强结构化完成协议，而是实现这条基础链路：

```text
Final Assistant Protocol
  -> Terminal Result Parser
  -> Missing-result Policy
  -> Runtime Metadata
  -> Headless Session Surface
  -> AgentSession-aware Core Tools
  -> Child Session Factory
  -> Run/Event Collector
  -> Subagent Task Tool
```

subagent 自身只负责调度：

- 选择 agent 定义。
- 创建 headless child session。
- 限制 child tools。
- 传入任务和最终输出格式要求。
- 等待 child run 完成。
- 解析最后 assistant 文本。
- 将结果返回给 parent agent。

不在 MVP 中实现：

- `yield` tool。
- `requireYieldTool`。
- output schema validation。
- incremental yield。
- nested task / `spawns` 配置。
- async jobs。
- child keep-alive/revival。
- MCP/LSP forwarding。
- isolated worktree。

## 2. MVP 完成协议

### 2.1 协议形态

child agent 的 system/user prompt 明确要求最后一条 assistant message 使用固定协议：

```text
SUBAGENT_RESULT
status: success
summary:
<简短总结>
details:
<必要细节、证据、文件、风险、失败原因>
```

失败时：

```text
SUBAGENT_RESULT
status: failure
summary:
<失败摘要>
details:
<为什么失败、已经完成了什么、还缺什么>
```

规则：

- `SUBAGENT_RESULT` 必须出现在最后 assistant message 中。
- `status` 只能是 `success` 或 `failure`。
- `summary` 必须存在。
- `details` 可以很长，用于保留全文和证据。
- parser 不需要理解所有自然语言，只需要确定 marker、status、summary/details 区块。
- 原始 assistant text 必须保留，方便 fallback/debug。

### 2.2 为什么不用自然语言“随便判断”

主 agent 和 subagent 都是智能体，确实可以读懂自然语言结果。但 runtime 层还需要一个确定性边界：

- 能判断 child 是否遵守协议。
- 能把 malformed result 视为失败，而不是让 parent 猜。
- 能在测试里断言成功/失败。
- 能给 UI 或 tool result 一个稳定 status。
- 能避免模型把“我完成了”写在中间段落里造成误判。

因此推荐“自然语言内容 + 很薄的机器可解析外壳”，而不是完全自由文本。

### 2.3 Missing-result 策略

当 child run 已结束但最后 assistant text 缺少 marker 或 status：

1. MVP 默认提醒一次：

   ```text
   Your previous response did not follow the required final result protocol.
   Reply now using the SUBAGENT_RESULT format with status, summary, and details.
   ```

2. 如果第二次仍然缺失或 malformed：

   - `status = "protocol_failure"`。
   - task tool 返回失败。
   - details 包含 child 的最后 assistant text。

3. 不建议静默 fallback 为 success。

推荐默认：

```ts
interface FinalAssistantProtocol {
  mode: "assistant-protocol";
  marker: "SUBAGENT_RESULT";
  statuses: readonly ["success", "failure"];
  missingResult: "remind-then-fail";
  maxReminders: 1;
}
```

## 3. 必要能力列表

| 能力 | 作用 | 为什么先做 | 推荐优先级 |
|------|------|------------|------------|
| Final Assistant Protocol | 定义 child 最后如何返回成功/失败、摘要和细节 | 替代 MVP 里的 `yield`，提供最小可靠出口 | P0 |
| Terminal Result Parser | 解析最后 assistant text 的 marker/status/summary/details | 让 runtime 能确定性判断结果，而不是全靠模型猜 | P0 |
| Missing-result Policy | marker 缺失或 malformed 时提醒一次或失败 | 防止 subagent “看似完成但不可判定” | P0 |
| Runtime Metadata | 给 session 标记 identity、surface、completion 等语义 | 避免 OMP 式裸 option 堆积 | P0 |
| Headless Session Surface | 明确 child session 无 UI，`ctx.hasUI === false` | subagent 不需要界面，交互能力必须关闭 | P0 |
| AgentSession-aware Core Tool | 内置 tool 能访问 parent `AgentSession` 和服务 | subagent 不能只靠 extension context 实现 | P0 |
| Dynamic System Prompt Override | 创建 child session 时提供动态 system prompt | child 需要独立角色和完成协议 prompt | P1 |
| Child Session Factory | 用 parent 服务创建 headless/in-memory child session | 复用 auth/model/settings，同时隔离 history | P1 |
| In-memory Session Lifecycle Helper | 统一创建、abort、dispose child session | 防止 child 资源泄漏 | P1 |
| Run/Event Collector | 收集 assistant text、tool calls、usage、stop reason | result parser 和进度展示都依赖它 | P1 |
| Abort Propagation | parent abort 时中断 child，并返回 partial result | 用户中断时必须安全 | P1 |
| Usage Aggregator | 汇总 child 的 token/cost/turns | 结果展示和预算控制需要 | P1 |
| Tool Activation Policy | 统一处理 allowlist、denylist、internal tools、feature flag | 子 agent 工具隔离的基础 | P1 |
| Nested-task Policy | 未来如果允许 child 再创建 subagent，用显式策略控制 | MVP 不需要；所有 child 都不能继续创建 subagent | P3 |
| Depth Metadata | 未来 nested task 的深度保护 | MVP 不需要；因为 child 没有 `task` tool | P3 |
| Debug Session Option | 可选保存 child JSONL/transcript | 非 MVP，但调试有帮助 | P3 |
| Schema Validation | 校验结构化输出 | 未来如果需要更强 contract 再做 | P3 |
| Optional Yield Tool | 显式 tool-call 完成协议 | 仅当最终文本协议实践后不够可靠再做 | P3 |

## 4. P0：必须先实现

### 4.1 Final Assistant Protocol

建议新增通用 completion 类型，但第一版只启用 assistant protocol：

```ts
interface CompletionContract {
  mode: "assistant-protocol" | "assistant-text";
  protocol?: FinalAssistantProtocol;
}

interface FinalAssistantProtocol {
  marker: "SUBAGENT_RESULT";
  missingResult: "remind-then-fail" | "fail";
  maxReminders: number;
}
```

作用：

- 声明本次 child run 期望如何完成。
- 让 prompt、parser、missing-result policy 使用同一份配置。
- 避免 `mode: yield`、`requireYieldTool`、`tools` 三者之间出现不一致。

第一版推荐：

```ts
completion: {
  mode: "assistant-protocol",
  protocol: {
    marker: "SUBAGENT_RESULT",
    missingResult: "remind-then-fail",
    maxReminders: 1,
  },
}
```

### 4.2 Terminal Result Parser

新增 parser：

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

parser 只做确定性解析：

- 从最后 assistant text 查找 `SUBAGENT_RESULT`。
- 解析 marker 之后的 `status:`。
- 分离 `summary:` 和 `details:`。
- 不判断内容真假。
- 不调用模型二次解释。

主 agent 是否相信结果，是另一层智能判断；runtime 只判断协议是否成立。

### 4.3 Missing-result Policy

executor 需要支持：

```ts
type MissingResultPolicy = "fail" | "remind-then-fail";
```

推荐：

- 默认 `remind-then-fail`。
- 最多提醒一次。
- 第二次 malformed 直接失败。
- 不默认 fallback success。

这能保留 `yield` 的第二个价值：可靠的成功/失败信号。区别是信号来自最终文本协议，而不是 tool call。

### 4.4 Runtime Metadata

新增 session runtime 元数据，不直接暴露一堆 option：

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
```

作用：

- 让 session 知道自己是 main 还是 subagent。
- 让 extension context 正确表达 UI surface。
- 后续如果引入 `yield`，也能挂在 `completion` 下，而不是加裸 option。

MVP 不需要在 runtime metadata 中加入 `spawn`。child 不能继续创建 subagent 的规则由工具注册层保证：child session 不注册 `task` tool。

### 4.5 Headless Session Surface

新增或明确：

```ts
interface SessionSurfaceOptions {
  mode: "interactive" | "rpc" | "json" | "print" | "headless";
}
```

规则：

- subagent 固定 `surface.mode = "headless"`。
- child extension context 中 `ctx.hasUI === false`。
- child 不提供 confirm/input/select/notify 等交互 UI。
- project-agent trust confirmation 必须在 parent task tool 内完成。

### 4.6 AgentSession-aware Core Tool

当前 extension tool 只能拿 `ExtensionContext`，不够实现 subagent。

需要支持 core tool factory：

```ts
createTaskTool(session: AgentSession): ToolDefinition
```

作用：

- 能访问 parent session。
- 能复用 parent `modelRegistry`、`settingsManager`、`sessionManager`。
- 能创建 child session。

## 5. P1：subagent 前最好具备

### 5.1 Dynamic System Prompt Override

child session 需要自己的 system prompt：

- agent role prompt。
- shared context。
- assignment。
- final result protocol。

建议：

- 不修改 parent resource loader。
- 用 wrapper 或 create option 提供 per-session dynamic prompt。
- child prompt 与 parent prompt 隔离。

### 5.2 Child Session Factory

新增内部 helper：

```ts
createChildAgentSession(parent, options)
```

作用：

- 创建 `SessionManager.inMemory(cwd)`。
- 复用 parent `modelRegistry`。
- 复用必要 settings。
- 绑定 headless surface。
- 注入 completion contract。
- 注入 subagent system prompt。

这样 subagent executor 不需要理解 `createAgentSession()` 的全部细节。

### 5.3 Run/Event Collector

统一监听 child session events：

- assistant final text。
- tool calls。
- usage。
- stop reason。
- errors。
- abort state。

输出：

```ts
interface AgentRunResult {
  status: "completed" | "failed" | "aborted";
  finalAssistantText: string;
  parsedResult?: ParsedSubagentResult;
  protocolFailure?: boolean;
  usage?: UsageSummary;
  toolCalls: ToolCallSummary[];
}
```

这可以先服务 subagent，后续也能服务其他 automation/workflow。

### 5.4 Abort Propagation

需要统一工具：

- parent signal abort -> child session abort。
- child abort 完成后 dispose。
- 返回 partial result。

不建议每个工具自己写一套 abort 逻辑。

### 5.5 Tool Activation Policy

需要一个统一函数处理：

- requested tools。
- excluded tools。
- default tools。
- internal tools。
- feature-disabled tools。

MVP 不再需要“protocol tool 自动激活 yield”。但仍然需要这个能力来保证：

- child 只能使用 agent definition 允许的工具。
- child session 永远不暴露 `task` tool。
- future internal tools 有统一入口。

## 6. P3：nested task 以后再说

MVP 不实现 nested task，也不需要 `spawns` 配置。所有 subagent 都不能继续创建 subagent。

实现规则：

- parent session 可以注册 `task` tool。
- child session 不注册 `task` tool。
- agent frontmatter 中即使写了 `task` 或 `spawns`，MVP 也忽略。
- child tool allowlist 中出现 `task` 时直接过滤掉。

如果未来确实需要 child 再创建 subagent，再引入新的显式策略：

- 不建议复刻 OMP 的 `spawns` 命名。
- 建议命名为 `nestedTask` 或 `allowedSubagents`。
- 必须同时实现 maxDepth、self-recursion guard、可测试的 tool exposure policy。

## 7. P3：其它可后置能力

### 7.1 Schema Validation

作用：

- 校验结构化输出。
- 支持更强的 typed subagent contract。

后置原因：

- 最终文本协议已经能承载 status/summary/details。
- schema validation 会牵出 retry、repair、错误展示。

### 7.2 Debug Session Persistence

作用：

- 可选保存 child JSONL/transcript。
- 调试子 session 很有用。

后置原因：

- MVP 可先用 in-memory。
- 避免一开始引入 session 文件生命周期和清理策略。

### 7.3 Optional Yield Tool

作用：

- 通过 tool call 显式提交最终结果。
- 提供比 assistant text 更硬的完成信号。

后置原因：

- 会引入 internal protocol tool、tool activation、collector、missing-yield retry、schema 边界等复杂度。
- 第一版可以通过 final assistant protocol 达到足够可靠。

触发条件：

- 实测模型经常不遵守最终文本协议。
- parent 需要强 typed output。
- 需要中途 incremental result。
- 需要 tool-call 级别的终止信号。

## 8. 推荐实现顺序

1. `CompletionContract` 和 `FinalAssistantProtocol` 类型。
2. `parseFinalAssistantResult()`。
3. missing-result reminder/failure policy。
4. runtime metadata。
5. headless surface / `ctx.hasUI === false`。
6. AgentSession-aware core tool factory 能力。
7. dynamic system prompt override。
8. child session factory。
9. run/event collector。
10. abort propagation helper。
11. 在这些基础上实现 `task` subagent tool。
12. 视实践结果决定是否加 optional `yield`。

## 9. 最小验收标准

在开始写完整 subagent 前，基础能力至少应能证明：

- 一个 headless child session 能被创建、prompt、dispose。
- child 不继承 parent message history。
- child 能复用 parent modelRegistry/auth。
- child 中 `ctx.hasUI === false`。
- child 最后一条 assistant text 按 `SUBAGENT_RESULT` 协议返回时，executor 能解析出 success/failure。
- child 缺少 marker/status 时，missing-result policy 生效。
- parent abort 能中断 child 并清理资源。
- 这些能力能用 faux provider 测试，不调用真实 API。

## 10. 结论

建议先实现这些基础能力，再实现 subagent。

最核心的前置能力是：

- Final Assistant Protocol。
- Terminal Result Parser。
- Missing-result Policy。
- Runtime Metadata。
- Headless Surface。
- AgentSession-aware Core Tool。
- Child Session Factory。
- Run/Event Collector。

`yield` 不作为第一版前置能力。它保留为 P3 optional upgrade：如果最终文本协议在真实使用中不够可靠，再把它作为更强完成通道补上。
