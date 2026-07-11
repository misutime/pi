# Subagent 实现复杂度分析

**范围**: `extensions/pi-xman/src/sub-agents/executor.ts`  
**日期**: 2026-07-10

---

## 复杂度排序

从"最易出错"到"最被低估"，实际复杂度排序如下。

### 1. 取消传播链（最易出错，不是最复杂）

逻辑不深，但窗口多、状态多，漏一个窗口就是 bug。此前反复修复的点集中在这里。

```
外部 AbortSignal
  → 初始 handler（设 aborted=true）
  → 检查点 1: reload 前
  → resourceLoader.reload()
  → 检查点 2: reload 后
  → createAgentSession()
  → 检查点 3: session 创建后 → session.abort()
  → bindExtensions({})
  → 检查点 4: bindExtensions 后 → session.abort()
  → handler 升级（替换为调用 session.abort()）
  → session.prompt()
  → 检查点 5: prompt 中/后（event listener + finally）
  → session.dispose()
```

关键设计点：

- **handler 升级**：prompt 前将 handler 从「只设 flag」替换为「调用 `session.abort()`」，因为只有此时 session 实例才存在
- **检查点 3/4 的 `session.abort()`**：虽然还不会发起 prompt，但需要中止可能已启动的异步流（如 resourceLoader 的后续加载）
- **`finalAssistantText`**：abort 消息中包含「最后输出」片段，帮助用户判断中断时的工作进度

### 2. 工具白名单与 extension 交互（最微妙）

```ts
createAgentSession({ tools: agent.tools })  // allowlist
  → 内置工具: 仅 allowlist 中的可用
  → extension 工具: 需要 bindExtensions({}) 后才注册
  → bindExtensions({}) 可能触发 session_start 注册动态工具
```

微妙之处：

| `tools` 值 | 行为 |
|------------|------|
| `undefined` | 默认全部内置工具；`bindExtensions` 后 extension 工具也全部激活 |
| `["read", "grep"]` | **仅** read/grep — 内置和 extension 工具都需显式列入 allowlist |
| `[]` | **零工具**（所有内置和 extension 工具均不激活） |

> 注意：`tools` 是 **allowlist**，不是 denylist。`["read", "grep"]` 只允许 read 和 grep，extension 工具（如 websearch）必须也显式列入才可用。

`tools: []` + `bindExtensions({})` = 零工具。但 `tools: undefined` + `bindExtensions({})` = 全部工具。差异来自 `createAgentSession` 的 `tools` 参数语义：**allowlist（允许哪些），不是 denylist（禁止哪些）**。

### 3. 结果收集（简单但有坑）

```ts
childSession.subscribe((event) => {
  if (event.type === "message_end" && msg.role === "assistant") {
    const textContent = msg.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("\n");
    if (textContent) {
      finalAssistantText = textContent;
    }
  }
});
```

隐含假设：**只取最后一条 assistant message**。

- 单次回复场景：正确
- tool use 循环（user → assistant → tool → assistant）：`finalAssistantText` 被覆盖，最终只保留最后一条 assistant。这是合理的——最终总结通常是最有价值的
- 多段独立回复场景（少见）：可能丢失中间段落

### 4. Prompt 工程（最被低估）

`buildSubagentSystemPrompt` 中的 headless 指令 + COMPLETION 协议决定了子代理的行为正确性：

```text
You are running as a headless subagent.
You must complete the assigned task without asking the user for input.
Use only the tools available to you.

ROLE
{agent.systemPrompt}

COMPLETION
Your last assistant message must summarize the result in natural language:
- Describe whether the task succeeded or failed, and why.
- Include specific evidence: file paths, code snippets, search results, or error details.
- Do not ask the user for input. If blocked, explain the reason clearly.
```

三个关键约束：

1. **不反问用户**（headless 模式的核心契约）
2. **最后一条消息是总结**（保证结果可解析）
3. **包含证据**（减少幻觉）

这三个约束只能靠人工评估验证，无法自动化测试。

---

## 投入优先级

| 优先级 | 方向 | 原因 |
|--------|------|------|
| **P0** | 结构化结果（success/failure/aborted） | 解决「执行完成 ≠ 成功」的可用性问题 |
| **P0** | 超时/轮数/输出上限 | 解决无资源预算的稳定性问题 |
| **P1** | 验证 prompt 行为正确性 | 人工评估 headless 约束是否被模型遵守 |
| **P2** | 多段 assistant 结果收集 | 当前覆盖的场景下已足够，边缘场景待观察 |

取消传播链已通过 31 个测试（含 provider 层 signal 传播）锁住各窗口，不再需要投入。工具白名单语义由 `createAgentSession` 保证，除非上游 SDK 变更，否则稳定。
