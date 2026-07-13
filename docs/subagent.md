# SubAgent（已移除）

> **状态**：已于 2026-07 移除。后续采用 [pi-subagents](https://github.com/nicobailon/pi-subagents) 作为外部方案。
>
> 本文档保留自研实现的架构摘要，用于与 pi-subagents 集成后对比。

## 架构

```
父进程 (AgentSession)
  ├── AgentManager：工具注册 + agent 配置管理
  ├── SubagentRuntime：子进程生命周期（fork + JSON-RPC over IPC）
  │     └── fork(workerPath) → ChildProcess
  └── spawn_agent 工具 → runtime.run() → 阻塞等待 → 返回结果

Worker 进程 (entry.ts)
  ├── 接收 agent/run RPC 请求
  ├── 创建 AgentSession（指定 model/tools/systemPrompt）
  ├── 执行 LLM 任务
  ├── 通过 agent/progress 通知上报工具调用
  └── 返回 RunResult（output + sessionPath + truncated）
```

## 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 进程模型 | `fork()` + Node IPC | Node-to-Node 最优；IPC 开箱即用；stdout 留给日志 |
| RPC 协议 | JSON-RPC 2.0 | 请求-响应匹配、超时、取消、通知分发，均为内置 |
| 认证 | 父子共享 `~/.pi/agent/auth.json` | 不通过 IPC 传递凭证 |
| 工具隔离 | 白名单（`tools` 字段） | 空数组 = 零工具，不会回退为默认工具集 |

## 功能清单

| 功能 | 实现 |
|------|------|
| Agent 配置来源 | `~/.pi/agent/agents/*.md`（YAML frontmatter：name/description/model/tools/systemPrompt） |
| 工具注册 | `spawn_agent`，参数 `{ agent, task }` |
| 系统提示词 | 动态追加可用 agent 列表及描述 |
| 并发控制 | 默认上限 5 个并行 |
| 超时 | 120s 全局超时 + RPC 请求级超时 |
| 中止 | abort signal → `agent/cancel` 通知 → 3s grace → SIGTERM → SIGKILL |
| 递归防护 | 子 agent 的 `excludeTools: ["spawn_agent"]` |
| 输出截断 | 50KB / 500 行 |
| TUI 展示 | 启动信息中显示 agent 列表 + 工具校验状态（ok/error/pending） |
| Worker 预检 | `Preflight` RPC：不调 LLM，仅验证扩展加载和工具可用性 |
| 会话持久化 | 子 agent 的 session JSONL 写入父 session 同目录 |

## 文件结构

```
packages/coding-agent/src/core/
├── rpc/                    # JSON-RPC 传输层（NodeIpcTransport + WorkerIpcTransport）
│   ├── types.ts / transport.ts / peer.ts / index.ts
└── subagent/               # 业务层
    ├── types.ts            # IAgentConfig
    ├── protocol.ts         # RPC method 常量 + 参数/结果类型
    ├── loader.ts           # ~/.pi/agent/agents/*.md 加载
    ├── runtime.ts          # fork + RPC 封装
    ├── entry.ts            # Worker 进程入口
    ├── manager.ts          # spawn_agent 工具定义 + 系统提示词
    └── index.ts

extensions/pix/             # 替代实现（进程内 AgentSession，已同步移除）
    └── src/tools/subagents/
```

## 不在本文档范围内的内容

以下功能自研实现中不存在，是预计 pi-subagents 提供的：

- Chain/Parallel/Async 编排
- 内置 agent（scout、researcher、planner、worker、reviewer 等）
- 后台运行 + 状态追踪
- TUI 确认界面（clarify UI）
- Agent 配置覆盖（settings.json agentOverrides）
- 父子通信（intercom）
- Profile 管理
- 链文件（.chain.md / .chain.json）
