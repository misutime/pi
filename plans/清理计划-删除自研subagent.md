# 清理计划：删除自研 SubAgent，保留其余全部改进

> 2026-07-13
> 基于《上游差异排查与集成方案》的决策结果。

## 原因

我们自研了三层 SubAgent 代码（core/subagent + core/rpc + extensions/pix，约 1400 行），功能上远不如成熟外部工具 [pi-subagents](https://github.com/nicobailon/pi-subagents)（8 内置 agent、chain/parallel/async 编排、TUI clarify UI、profiles、父子通信等）。同时为了支持这套自研实现，在 `agent-session.ts`、`interactive-mode.ts` 等核心文件中植入了约 200 行耦合代码。

落实"不重复造轮子"的设计哲学，必须删除这套自研实现，为后续集成 pi-subagents + pi-mcp-adapter 腾出干净的代码基线。

## 目标

本次有意下线 `spawn_agent`、`call_agent` 工具及 `~/.pi/agent/agents/` 配置机制。pi-subagents 的安装与兼容验证是后续独立任务，不在本计划范围内。

1. 移除全部自研 SubAgent 代码（目录 + 核心文件中的耦合代码）
2. 保留所有独立改进（约 30 项，含 webtools、github-tools、TUI 增强、AI 包修复等）
3. 清理后检查和非 e2e 测试通过

## 删除清单

仅删除自研 SubAgent 三层代码及其在核心文件中的引用。不触及 webtools、github-tools、任何独立改进。

| 删除项 | 位置 |
|--------|------|
| SubAgent 核心（#1） | `packages/coding-agent/src/core/subagent/` 全部 7 文件 |
| RPC 传输层（#1） | `packages/coding-agent/src/core/rpc/` 全部 4 文件 |
| pix 扩展（#2） | `extensions/pix/` 全部 ~10 文件 |
| 计划文档（#7） | `subagent-plan.md`、`subagent-phase2.md` |
| agent-session 引用（#8-17, #20） | 见下方逐行说明 |
| interactive-mode 引用（#29-31） | 见下方逐行说明 |
| sdk.ts 透传（#42 中一行） | 见下方逐行说明 |

---

## 操作步骤

### 步骤 1：整块删除

```bash
rm -rf packages/coding-agent/src/core/subagent/
rm -rf packages/coding-agent/src/core/rpc/
rm -rf extensions/pix/
rm -f subagent-plan.md subagent-phase2.md
```

### 步骤 1b：刷新锁文件

删除 `extensions/pix/` 后，它是根 workspace 的成员，`package-lock.json` 中仍有残留。需刷新：

```bash
npm install --package-lock-only --ignore-scripts
```

然后检查 shrinkwrap 和 install-lock 是否需要同步更新：

```bash
npm run check:shrinkwrap
npm run check:install-lock:coding-agent
```

### 步骤 1c：更新过时文档

`docs/subagent.md` 声明的 `spawn_agent`、`core/subagent`、`core/rpc` 均已移除。已重写为简洁的架构摘要，标注"已移除"状态，保留核心设计决策和功能清单以备后续与 pi-subagents 对比。

---

### 步骤 2：清理 `packages/coding-agent/src/core/agent-session.ts`

**删除 import 行：**

```typescript
// 删除以下 import
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, isBunBinary } from "../config.ts";
import type { IAgentConfig } from "./subagent/index.ts";
import { AgentManager, loadAgentsFromDir, SubagentRuntime } from "./subagent/index.ts";
```

**恢复 import：**

```typescript
// 原来 import { createAllToolDefinitions } from "./tools/index.ts";
// 改为：
import { allToolNames, createAllToolDefinitions } from "./tools/index.ts";
```

**删除函数 `resolveSubagentWorkerPath()`**（第 271-287 行，整段）。

**删除 AgentSessionConfig 字段：**

```typescript
// 删除
agentDir?: string;
```

**删除 `_subagentRuntime` 等 4 个 private 字段**（第 362-371 行）。

**删除 `agents`、`agentToolValidation`、`agentPreflight` 3 个 getter**（第 374-399 行）。

**删除 `runAgentPreflight()` 方法**（第 401-405 行）。

**删除构造函数中 subagent 初始化块**（第 433-455 行，`{ const agentDir = ... }` 整段）。

**删除 `dispose()` 中的** `this._subagentRuntime?.shutdown();`（第 928 行，单行）。

**删除系统 prompt 构建中的 agent 列表追加** — 在 `_buildSystemPromptInternal` 中：

```typescript
// 恢复：
const appendSystemPrompt =
    loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
// （删除 if (this._subagentManager && ...) 块）
```

**删除 `_buildRuntime()` 中的 spawn_agent 注册**（约第 2654 行）：

```typescript
// 删除
if (this._subagentManager) {
    this._baseToolDefinitions.set("spawn_agent", this._subagentManager.getToolDefinition() as ToolDefinition);
}
```

**删除 `_buildRuntime()` 中的 spawn_agent push**（约第 2682 行）：

```typescript
// 恢复：
const defaultActiveToolNames = this._baseToolsOverride
    ? Object.keys(this._baseToolsOverride)
    : [...allToolNames];
const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
// （删除 if (this._subagentManager) { baseActiveToolNames.push("spawn_agent"); }）
```

**删除 `_buildRuntime()` 中的 agent 工具校验**（约第 2694-2698 行）：

```typescript
// 删除整段
if (this._subagentManager) {
    const availableTools = new Set(this._toolRegistry.keys());
    this._agentToolValidation = this._subagentManager.validateTools(availableTools);
}
```

### 步骤 3：清理 `packages/coding-agent/src/core/sdk.ts`

**删除 `agentDir` 透传行**（约第 399 行）：

```typescript
// 删除
agentDir,
```

### 步骤 4：清理 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

**删除 preflight 调用**（约第 748 行）：

```typescript
// 删除整段
void this.session.runAgentPreflight().then(() => {
    this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    this.ui.requestRender();
});
```

**删除 Agents 列表展示段**（约第 1578-1617 行，`// Show loaded agents` 整段）。

**删除 preflight 错误合并**（约第 1658-1662 行）：

```typescript
// 删除
const preflightErrors = this.session.agentPreflight?.extensionErrors ?? [];
for (const err of preflightErrors) {
    extensionDiagnostics.push({ type: "error", message: err.error, path: err.path });
}
```

### 步骤 5：清理 `packages/coding-agent/src/core/index.ts`

```typescript
// 删除 re-export（如果存在 subagent 相关导出）
// loadBuiltinExtensions 保留（#22 保留）
```

检查是否有 `subagent` 或 `rpc` 相关导出，删除之。

### 步骤 5b：零引用检查

删完代码后确认没有任何残余引用：

```bash
# 不应再有 spawn_agent 引用（零输出 = 干净）
rg 'spawn_agent' packages/coding-agent/src/ --type ts
# 不应再有 runAgentPreflight 引用
rg 'runAgentPreflight' packages/coding-agent/src/ --type ts
# 不应再有 subagent 内部模块路径引用
rg "from.*['\"]\.\.?/subagent/" packages/coding-agent/src/ --type ts
rg "from.*['\"]\.\.?/rpc/" packages/coding-agent/src/ --type ts
```

每条 rg 应**零输出**。有匹配行 = 遗漏引用需处理；rg 自身报错（exit code 2）需排查。

### 步骤 6：静态验证

```bash
npm run check                          # 类型检查 + lint + shrinkwrap
git diff --check                       # 确保没有空白错误
./test.sh                              # 单元测试（Unix-only）
```

所有检查必须通过。`npm run check` 包含 shrinkwrap 校验，会确认锁文件同步。

> **注意**：`docs/subagent.md` 的"已移除"修改与代码删除应在同一 commit 落地，不可单独先提交。

### 步骤 7（可选）：冒烟测试

以下会调用已配置模型、产生会话和费用，仅在明确需要时执行：

```bash
./pix -p "Say exactly: ok"
```

预期输出含 `ok`，无异常。

---

## 清理后的 agent-session.ts 状态

保留的改动（不受影响）：

| # | 内容 |
|---|------|
| #18 | `_runSystemPromptPersisted` 快照机制 |
| #19 | 默认工具 7 个（`[...allToolNames]`） |
| #21 | `_getCompactionRequestAuth` 重命名 |

不再存在的内容：

| # | 内容 |
|---|------|
| #8-17, #20 | 所有 subagent 代码块 |

---

## 不再需要的文件

清理后以下文件失去所有引用，但仍存在（不删除，因为 #22 保留）：

- `packages/coding-agent/src/core/extensions/loader.ts` 中的 `loadBuiltinExtensions()` — 保留（#22 决策）
- `packages/coding-agent/src/core/resource-loader.ts` 中的两处 `loadBuiltinExtensions()` 调用 — 保留（#27 决策）
