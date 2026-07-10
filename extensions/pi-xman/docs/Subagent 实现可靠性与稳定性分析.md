# Subagent 实现可靠性与稳定性分析

**范围**: `extensions/pi-xman/src/sub-agents/executor.ts` 及相关模块  
**日期**: 2026-07-10  
**结论**: 当前路线适合"在同一 Pi 进程内委派短任务"的轻量 subagent；不是强隔离的 worker/sandbox，也不适合无限时、强审计或必须确定成功的关键任务。

---

## 架构概览

```
call_agent 工具 (call-agent.ts)
  ├─ loadAgentsFromDir()       → 从 ~/.pi/agent/agents/*.md 加载 agent 配置
  ├─ 参数校验 (agent 名、task 非空)
  └─ runSubagent()             → 子 session 执行引擎
       ├─ buildSubagentSystemPrompt()   → headless + ROLE + COMPLETION 协议
       ├─ buildSubagentUserPrompt()     → AGENT + TASK 格式
       ├─ resolveCliModel()             → 解析模型字符串
       ├─ DefaultResourceLoader         → 独立资源加载（noSkills/Context/Prompt）
       ├─ createAgentSession()          → 子 AgentSession（内存 session manager）
       ├─ bindExtensions({})            → 加载 extension 工具
       ├─ session.prompt()              → 发送任务 → 等待模型回复
       └─ session.dispose()             → 销毁子 session
```

核心设计决策：

- **复用 Pi 原生 `createAgentSession`**，不自建 agent loop。模型调用、重试、工具执行、session 生命周期走同一套成熟路径。
- **子 session 使用内存 `SessionManager.inMemory()`**，完成后 `dispose()`，不写入主会话历史。
- **`tools` 是实际 allowlist**，在 `createAgentSession` 层面控制，同时支持内置工具和 extension 工具。
- **取消信号在四个关键窗口检查**：reload 前/后、session 创建后、bindExtensions 后、prompt 前/后。

---

## 可靠性基础

### 已建立的安全边界

| 层级 | 机制 | 状态 |
|------|------|------|
| 配置加载 | `loadAgentsFromDir` 校验 name/description/model/tools，解析失败收集错误 | ✅ 已测试 |
| 模型解析 | `resolveCliModel` → 失败时 fallback 到 `fallbackModel` 或返回终止消息 | ✅ 已测试 |
| 工具白名单 | `createAgentSession({ tools: agent.tools })` — `[]` 表示零工具 | ✅ 已测试 |
| 动态工具 | `bindExtensions({})` 支持 extension `session_start` 注册工具 | ⚠️ 基础路径已测，动态注册端到端待补 |
| 取消传播 | `AbortSignal` → 升级 handler → `session.abort()` → `agent.abort()` | ✅ 已测试 |
| 异常兜底 | try/catch → 区分 abort 异常与执行异常 → 返回中文终止消息 | ✅ 已测试 |

### 配置校验矩阵

`loadAgentsFromDir` 的错误覆盖：

| 条件 | 错误信息 |
|------|----------|
| 无效 YAML | `YAML 解析失败` |
| 缺少 name / 非字符串 | `缺少 name 字段` |
| 缺少 description / 非字符串 | `缺少 description 字段` |
| 缺少 model / 非字符串 | `缺少 model 字段，必须指定模型` |
| tools 项非字符串 | `tools 第 N 项不是字符串` |

### 取消窗口

`runSubagent` 在以下位置检查 `aborted` 标志：

1. **reload 前** — 返回 `任务被中断`
2. **reload 后、session 创建前** — 返回 `任务被中断`
3. **session 创建后、bindExtensions 前** — 调用 `session.abort()` + 返回 `任务被中断`
4. **bindExtensions 后、prompt 前** — 调用 `session.abort()` + 返回 `任务被中断`
5. **prompt 中 / prompt 后** — 升级 handler 调用 `session.abort()` + 返回 `任务被中断（含最后输出）`

---

## 边界与风险

### 1. 不是沙箱

子代理与主代理共享同一进程、cwd、认证凭据、文件系统和已加载 extension。白名单限制的是**可调用工具**，不影响 extension 生命周期代码的执行。

**风险**: 若加载了有副作用的 extension（文件写入、网络请求等），即使 tools 白名单不含相关工具，extension 的 `session_start` 等钩子仍会运行。

**建议**: 只加载可信 extension。允许 `bash` / `write` 就等同允许子代理修改真实工作区。

### 2. 无资源预算

当前无以下限制：

- 总超时
- 最大对话轮数（agent loop iterations）
- 最大工具调用数
- 最大返回文本量
- 并发子代理数量

**风险**: 模型卡住、工具反复调用、返回过长内容时，只能依赖人工取消和底层 provider 超时。

### 3. "执行完成" ≠ "任务成功"

最终结果来自模型自然语言。模型可能：

- 报告失败但未重试
- 省略关键证据
- 输出为空（显示 `(无输出)`）
- 产生幻觉内容

代码层面只能确认 session 已结束，不能判断语义层面的成功/失败。

**建议**: 需要可靠机器判断时，保留自然语言文本，同时返回最小结构化状态（如 `success | failure | aborted` + 摘要 + 证据片段）。

### 4. Extension 耦合

当前路线正确保留了 extension 加载以支持 `websearch` 等工具，但存在以下风险：

- `call_agent` 工具可能被配入子代理的 tools 白名单，形成嵌套委派
- 无递归深度限制

**建议**: 避免把 `call_agent` 配进子代理工具，或增加递归深度限制。

### 5. 并行与并发

`runSubagent` 是 `async`，理论上可以并行调用多次。但：

- 无并发数限制
- 多个子代理共享同一 cwd 和文件系统
- `dispose()` 是最佳努力清理，不会阻塞

**建议**: 对并行委派场景，应在外层控制并发数。

---

## 测试覆盖

当前 `sub-agents.test.ts` 共 31 个测试，覆盖矩阵：

| 模块 | 覆盖点 | 数量 | 状态 |
|------|--------|------|------|
| loader | 有效解析、逗号工具、空工具、无效 YAML、缺失字段、非字符串字段、多错误聚合、非 markdown 跳过 | 15 | ✅ |
| prompt | headless 指令、ROLE 体、旧格式清除、name fallback、user prompt 格式 | 4 | ✅ |
| executor | 预取消、模型解析失败 | 2 | ✅ (已有) |
| executor | faux 成功路径、空工具 context 断言 | 2 | ✅ (新增) |
| executor | fallbackModel + console.error spy | 1 | ✅ (新增) |
| executor | prompt 中 abort + abortSpy | 1 | ✅ (新增) |
| executor | bind 前 abort + callCount 零调用断言 | 1 | ✅ (新增) |
| call_agent | 配置错误 throw、未知 agent、空/空白 task、成功执行、执行失败 | 5 | ✅ (新增) |

### 待补测试

| 缺口 | 原因 |
|------|------|
| abort during reload / createAgentSession 窗口 | 无可靠异步注入点（同构逻辑已验证） |
| bindExtensions + session_start 动态注册工具端到端 | executor 内部创建 resourceLoader，不暴露 extensionFactories 注入点 |
| 大文本截断 / 多轮工具调用 / 并发 | 需要更复杂的 scenario 模拟 |

---

## 推荐投入优先级

### 短期（提升可靠性）

1. **超时/轮数/输出上限** — 对 `runSubagent` 增加可选的超时参数、最大工具调用轮数和最大返回文本长度
2. **结构化完成状态** — 返回值从纯文本扩展为 `{ status: "success" | "failure" | "aborted", summary: string, evidence?: string, error?: string }`
3. **验证 abort 后 provider 零调用** — 已在 bind-before-prompt 测试中覆盖（断言 `callCount === 0`）；补上动态 extension 工具的端到端需要在 executor 中暴露 `extensionFactories` 或允许注入 resourceLoader

### 中期（扩展能力）

4. **递归深度限制** — 在 `call_agent` 工具中检测或阻止 `call_agent` 出现在子代理 tools 白名单中
5. **并发控制** — 在 `call_agent` 工具中增加最大并发子代理数
6. **结构化结果** — 为 `call_agent` 工具的输出增加可选的 JSON schema 约束

### 长期（强隔离场景）

7. **独立进程 worker** — 对需要强隔离的场景（不可信 extension、长时间任务），考虑将子代理放入独立 worker 进程
8. **审计日志** — 记录子代理的模型调用、工具调用、耗时和结果，用于排查问题

---

## 适用场景判断

| 场景 | 适用 | 注意 |
|------|------|------|
| 代码审查 | ✅ | 只给 read/grep/find 工具 |
| 搜索与资料整理 | ✅ | 配合 websearch extension 使用 |
| 局部实现任务 | ✅ | 谨慎给予 write/bash |
| 破坏性操作（rm -rf、git push） | ⚠️ | 需在外层二次确认 |
| 长时间批量任务 | ❌ | 无超时/预算保护 |
| 并行大规模委派 | ❌ | 无并发控制 |
| 可审计确定结果 | ❌ | 无结构化状态返回 |
