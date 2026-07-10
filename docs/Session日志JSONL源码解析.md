# Session 日志（JSONL）源码解析

## 输出位置

```
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

示例：

```
C:\Users\Misu\.pi\agent\sessions\--C--Users-Misu--\2026-07-10T03-45-55-655Z_019f4a21-c7c7-71ae-9ec1-dc17b7b9b7f3.jsonl
```

## 源码位置

核心文件：`packages/coding-agent/src/core/session-manager.ts`

---

## 1. 目录路径生成

**`session-manager.ts:472-476`** — `getDefaultSessionDirPath()`

```ts
function getDefaultSessionDirPath(cwd: string, agentDir: string): string {
    const resolvedCwd = resolvePath(cwd);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(resolvedAgentDir, "sessions", safePath);
}
```

编码规则：`C:\Users\Misu\` → `--C--Users-Misu--`（盘符冒号、路径分隔符均替换为 `-`）。

---

## 2. 文件名生成

**`session-manager.ts:884`** — `SessionManager.initSession()` 中

```ts
const fileTimestamp = timestamp.replace(/[:.]/g, "-");
this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
```

格式：`2026-07-10T03-45-55-655Z_<uuid>.jsonl`

---

## 3. 写入策略

**`session-manager.ts:947-971`** — `_persist()`

分两个阶段：

| 阶段 | 条件 | 行为 |
|------|------|------|
| 缓存期 | 尚无 assistant 消息 | 内存中累积，不落盘 |
| 持久期 | 首条 assistant 消息到达 | `_rewriteFile()` 全量写入，之后逐条 `appendFileSync()` 追加 |

全量写入（`_rewriteFile`，第 910 行）：

```ts
private _rewriteFile(): void {
    if (!this.persist || !this.sessionFile) return;
    const fd = openSync(this.sessionFile, "w");
    try {
        for (const entry of this.fileEntries) {
            writeFileSync(fd, `${JSON.stringify(entry)}\n`);
        }
    } finally {
        closeSync(fd);
    }
}
```

增量追加（第 952 行）：

```ts
appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
```

---

## 4. 触发链路

```
Agent 事件
  → AgentSession._handleAgentEvent()       (agent-session.ts)
    → sessionManager.appendMessage()       (session-manager.ts)
    → sessionManager.appendEntry()
    → sessionManager.appendCompactionEntry()
      → _persist(entry)                    → 写入 JSONL
```

每次 agent 产生消息（user / assistant / tool result）或扩展调用 `appendEntry()` 时触发。

---

## 5. 初始化入口

SDK 层创建 SessionManager：

**`sdk.ts:180`**

```ts
const sessionManager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
```

继承已有 session 时：

**`session-manager.ts:1452`** — `SessionManager.open(path)`

```ts
static open(path: string): SessionManager {
    // 从已有 JSONL 文件读取 entry 重建状态
}
```

---

## 6. 文件格式

每行一个 JSON 对象（JSONL）：

```json
{"type":"session","version":2,"timestamp":"2026-07-10T03:45:55.655Z","sessionId":"019f4a21-..."}
{"type":"message","id":"msg_1","parentId":null,"message":{"role":"user","content":"hello"}}
{"type":"message","id":"msg_2","parentId":"msg_1","message":{"role":"assistant","content":"..."}}
{"type":"active_tools_change","id":"...","activeToolNames":["read","bash","edit","write"]}
```

首行固定为 `type: "session"` 的 header entry，后续为消息、压缩、工具变更等 entry。

---

## 关键源文件索引

| 文件 | 内容 |
|------|------|
| `packages/coding-agent/src/core/session-manager.ts` | SessionManager 类、路径编码、JSONL 读写 |
| `packages/coding-agent/src/core/agent-session.ts` | `_handleAgentEvent()` 触发持久化 |
| `packages/coding-agent/src/core/sdk.ts` | `SessionManager.create()` 初始化入口 |
