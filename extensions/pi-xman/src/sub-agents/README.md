# Sub-agents

子代理（sub-agent）扩展，允许主 agent 通过 `call_agent` 工具将任务委派给独立的、上下文隔离的专业子代理执行。

## 文件结构

```
sub-agents/
├── call-agent.ts   # 入口：注册 call_agent 工具，解析参数，编排调用
├── loader.ts       # 从 ~/.pi/agent/agents/ 加载 agent markdown 配置
├── executor.ts     # 创建子 session 并执行子代理任务
├── prompt.ts       # 构建子代理的 system prompt 和 user prompt
├── types.ts        # 共享类型定义
└── README.md
```

## 数据流

```
用户输入 "call_agent code-reviewer 检查 PR #42"
  │
  ▼
callAgent()                         [call-agent.ts]
  ├── loadAgentsFromDir()           [loader.ts]
  │     └── 读取 ~/.pi/agent/agents/*.md → IAgentConfig[]
  ├── 校验参数、查找 agentConfig
  └── runSubagent()                 [executor.ts]
        ├── buildSubagentSystemPrompt()  [prompt.ts]
        ├── buildSubagentUserPrompt()    [prompt.ts]
        ├── resolveCliModel()       ← 解析 agent 配置的 model（支持 :thinking 后缀）
        ├── createAgentSession()    ← 创建内存态子 session
        ├── childSession.prompt()   ← 发送任务
        ├── 事件收集（message_end / tool_execution_start）
        └── 返回结果
```

## Agent 配置格式

在 `~/.pi/agent/agents/` 下放置 `.md` 文件，使用 frontmatter 声明元数据，正文为 system prompt：

```markdown
---
name: code-reviewer
description: 审查代码变更，提供反馈和改进建议
model: deepseek-v4-flash:medium
tools:
  - read
  - grep
  - find
  - ls
---

You are a code reviewer. Focus on:
1. Logic correctness
2. Security issues
3. Performance concerns
...
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✓ | 代理名称，LLM 通过此名称调用 |
| `description` | ✓ | 用途描述，会嵌入 tool description 供 LLM 参考 |
| `model` | ✗ | 指定模型，支持 `provider/model` 或 `modelId:thinkingLevel` 格式 |
| `tools` | ✗ | 工具列表，逗号分隔字符串或 YAML 数组；不填则无工具可用 |

## 子代理协议

子代理执行完成后，最后一条 assistant message 需包含 `SUBAGENT_RESULT` 标记：

```
SUBAGENT_RESULT
status: success | failure
summary:
<简要结果>
details:
<详细证据、文件路径、失败原因>
```

## 待完善

- [ ] `runSubagent` 返回结果目前固定为 `{ content: [], details: {} }`，需改为结构化输出（status / summary / details / usage / toolCalls）
- [ ] `IAgentConfig.tools` 类型标注为 `string[]`，但 loader 可能产出 `undefined`，类型需统一
- [ ] 子代理目前无工具白名单过滤——`agent.tools` 直接传给 `createAgentSession`，若指定了不存在的工具名行为未定义
- [ ] 执行结果中的 `usage` / `toolCalls` / `messages` 已收集但未返回给主 agent
- [ ] `createHeadlessResourceLoader` 目前返回空资源（无 skills/prompts/themes），后续可考虑是否允许子代理加载特定资源
