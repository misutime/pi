# SubAgent Phase 1 实现计划

## 定位

Pi 从单 Agent Runtime 向多 Agent Runtime 演进。Phase 1 只做一件事：**可靠的前台子 agent 委派**。

```
spawn_agent.execute → runtime.run(task, signal) → Promise<result>
                    → 私有 RuntimeRecord（worker / timer / finalize / progress）
                    → result / error / timeout / cancel → 幂等 finalize → 移除
```

后台模式、list_agents、统计信息、用户可配置 agent 全部留给 Phase 2。

---

## 一、核心原则

- **前台阻塞**：spawn_agent 阻塞等结果。并行下多个同时推进。
- **父进程是唯一超时/abort 权威**：worker 不设自身超时。
- **一次终态**：worker 与父进程各有幂等 finalize。
- **收到终态 IPC = finalize + 等 worker disconnect；只有超时或 abort 到期才 kill**。

---

## 二、SubagentRuntime

### 2.1 核心 API

```typescript
class SubagentRuntime {
  private _active = new Map<string, RuntimeRecord>();
  private _maxConcurrency: number;
  private _timeoutMs: number;
  private _abortGraceMs: number;
  private _workerPath: string;
  private _execArgv: string[] | undefined;

  constructor(opts: {
    workerPath: string;
    execArgv?: string[];
    maxConcurrency?: number;   // 默认 5
    timeoutMs?: number;        // 默认 120000
    abortGraceMs?: number;     // 默认 3000
  }) {
    this._workerPath = opts.workerPath;
    this._execArgv = opts.execArgv;
    this._maxConcurrency = opts.maxConcurrency ?? 5;
    this._timeoutMs = opts.timeoutMs ?? 120_000;
    this._abortGraceMs = opts.abortGraceMs ?? 3_000;
  }

  run(
    task: string,
    config: SubAgentConfig,
    signal: AbortSignal | undefined,
    onProgress: (toolName: string) => void,
  ): Promise<SubagentResult>;

  shutdown(): void;
}

interface SubagentResult {
  output: string;
  sessionPath: string;
  truncated: boolean;
}
```

### 2.2 私有 RuntimeRecord

```typescript
interface RuntimeRecord {
  worker: ChildProcess;
  deferred: {
    resolve: (result: SubagentResult) => void;
    reject: (error: Error) => void;
  };
  // 每个 run() 独立的进度回调
  onProgress: (toolName: string) => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  abortGraceTimer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  onExit?: (code: number | null, signal: string | null) => void;
  finalized: boolean;
  _cleanup?: () => void;  // shutdown 复用清理路径
}
```

### 2.3 run() 实现

```typescript
private _active: Map<string, RuntimeRecord> = new Map();

async run(
  task: string,
  config: SubAgentConfig,
  signal: AbortSignal | undefined,
  onProgress: (toolName: string) => void,
): Promise<SubagentResult> {
  const agentId = generateId();

  if (this._active.size >= this._maxConcurrency) {
    throw new Error(`Subagent concurrency limit (${this._maxConcurrency}) reached`);
  }
  if (signal?.aborted) {
    throw new Error("Aborted before spawn");
  }

  // fork
  let worker: ChildProcess;
  try {
    worker = fork(this._workerPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: this._execArgv,
    });
  } catch (err) {
    throw new Error(`Failed to fork subagent: ${err instanceof Error ? err.message : String(err)}`);
  }

  const record: RuntimeRecord = {
    worker,
    deferred: { resolve: undefined!, reject: undefined! },
    onProgress,
    finalized: false,
  };
  this._active.set(agentId, record);

  return new Promise<SubagentResult>((resolve, reject) => {
    record.deferred = { resolve, reject };

    // ═══════════════════════════════════════
    // finalize（幂等）
    // ═══════════════════════════════════════
    const finalize = (resolved: SubagentResult | null, error: Error | null): void => {
      if (record.finalized) return;
      record.finalized = true;
      cleanup();
      this._active.delete(agentId);
      if (resolved) resolve(resolved);
      else reject(error!);
    };

    // shutdown 也走这条清理路径
    const cleanup = (): void => {
      if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
      if (record.abortGraceTimer) clearTimeout(record.abortGraceTimer);
      if (record.killTimer) clearTimeout(record.killTimer);
      if (record.abortListener && signal) {
        try { signal.removeEventListener("abort", record.abortListener); } catch { /* ignore */ }
      }
      // 移除 message listener（不再接收 IPC）
      worker.removeAllListeners("message");
      // 保留 exit 和 error listener 直到进程真正结束
      // （terminate 期间的 kill/error 事件由它们安全处理）
    };
    record._cleanup = cleanup;

    // ═══════════════════════════════════════
    // terminate：硬杀
    // ═══════════════════════════════════════
    let terminationStarted = false;
    const terminate = (): void => {
      if (terminationStarted) return;
      // 检查进程是否已经退出（exitCode/signalCode 是真实退出状态）
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      terminationStarted = true;
      try { worker.kill("SIGTERM"); } catch { /* ignore */ }
      record.killTimer = setTimeout(() => {
        // 回调时再次确认进程仍存活（不依赖 worker.killed）
        if (worker.exitCode !== null || worker.signalCode !== null) return;
        try { worker.kill("SIGKILL"); } catch { /* ignore */ }
      }, this._abortGraceMs);
    };

    // 1. 超时
    record.timeoutTimer = setTimeout(() => {
      if (!record.finalized) {
        finalize(null, new Error("Subagent timed out"));
        terminate();
      }
    }, this._timeoutMs);

    // 2. abort signal
    if (signal) {
      record.abortListener = () => {
        // 幂等：abortGraceTimer 已存在说明正在处理
        if (record.abortGraceTimer !== undefined) return;
        if (record.finalized) return;
        // 优雅：发 cancel IPC
        try { worker.send({ type: "cancel" } satisfies ParentMessage); } catch { /* ignore */ }
        // abort grace 内等 worker error IPC
        record.abortGraceTimer = setTimeout(() => {
          if (!record.finalized) {
            finalize(null, new Error("Aborted"));
            terminate();
          }
        }, this._abortGraceMs);
      };
      signal.addEventListener("abort", record.abortListener, { once: true });
      // 注册后再次检查：signal 可能在 register 期间已被 abort
      if (signal.aborted) {
        record.abortListener();
      }
    }

    // 3. worker IPC
    worker.on("message", (msg: WorkerMessage) => {
      switch (msg.type) {
        case "tool_call":
          record.onProgress(msg.name);
          break;
        case "result":
          // 正常终态：finalize，不 kill
          finalize(
            { output: msg.output, sessionPath: msg.sessionPath, truncated: msg.truncated },
            null,
          );
          break;
        case "error":
          // worker 已自行 disconnect；只 finalize，不 kill
          finalize(null, new Error(msg.message));
          break;
      }
    });

    // 4. worker exit（清理 killTimer，终态时 idempotent）
    record.onExit = (code, sig) => {
      // 无论是否 finalized，清理 killTimer（防止泄漏）
      if (record.killTimer) { clearTimeout(record.killTimer); record.killTimer = undefined; }
      if (!record.finalized) {
        finalize(null, new Error(`Worker exited code=${code} signal=${sig}`));
      }
    };
    worker.on("exit", record.onExit);

    // 5. worker error 事件
    worker.on("error", (err) => {
      if (!record.finalized) {
        finalize(null, new Error(`Worker error: ${err.message}`));
        terminate();
      }
    });

    // 6. 发送任务
    try {
      worker.send({
        type: "run",
        agentId,
        task,
        config,
      } satisfies ParentMessage, (err) => {
        if (err && !record.finalized) {
          finalize(null, new Error(`Failed to send task: ${err.message}`));
          terminate();
        }
      });
    } catch (err) {
      finalize(null, new Error(`Failed to send task: ${err instanceof Error ? err.message : String(err)}`));
      terminate();
    }
  });
}
```

### 2.4 shutdown

```typescript
shutdown(): void {
  for (const [agentId, record] of this._active) {
    // 清理 timer/listener，reject pending run
    if (!record.finalized) {
      record.finalized = true;
      record._cleanup?.();
      record.deferred.reject(new Error("Session shutting down"));
    } else {
      record._cleanup?.();
    }
    // 兜底杀进程
    try { record.worker.kill("SIGKILL"); } catch { /* ignore */ }
  }
  this._active.clear();
}
```

---

## 三、Worker 入口

### 3.1 导入

```typescript
// entry.ts — 同包内部相对 import
import { createAgentSession } from "../sdk.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { SessionManager } from "../session-manager.ts";
import type { AgentSession } from "../agent-session.ts";
import type { ParentMessage, WorkerMessage, SubAgentConfig } from "./protocol.ts";
```

### 3.2 核心逻辑

```typescript
interface ContentBlock { type: string; text?: string; }

let currentController: AbortController | undefined;
let abortListener: (() => void) | undefined;

class CancelError extends Error {
  constructor() { super("Cancelled"); this.name = "CancelError"; }
}

process.on("message", (msg: ParentMessage) => {
  switch (msg.type) {
    case "run":
      void handleRun(msg.agentId, msg.task, msg.config);
      break;
    case "cancel":
      currentController?.abort();
      break;
  }
});

async function handleRun(
  agentId: string, task: string, config: SubAgentConfig,
): Promise<void> {
  const controller = new AbortController();
  currentController = controller;

  let childSession: AgentSession | undefined;
  let finalAssistantText = "";
  let finalStopReason: string | undefined;
  let finalErrorMessage: string | undefined;
  let stoppedByTurnBudget = false;
  let finalized = false;

  const finalize = (msg: WorkerMessage): void => {
    if (finalized) return;
    finalized = true;
    if (abortListener && childSession) {
      controller.signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
    process.send!(msg, undefined, undefined, () => {
      process.disconnect();
    });
    if (childSession) {
      try { childSession.dispose(); } catch { /* best-effort */ }
    }
  };

  try {
    const checkCancelled = () => {
      if (controller.signal.aborted) throw new CancelError();
    };

    const sessionManager = SessionManager.create(config.cwd, config.sessionDir);
    if (config.parentSession !== undefined) {
      sessionManager.newSession({ parentSession: config.parentSession });
    } else {
      sessionManager.newSession();
    }
    const sessionPath = sessionManager.getSessionFile();
    if (sessionPath === undefined) {
      // SessionManager 未启用 persist，无法生成 session 文件
      throw new Error("Subagent requires persistent session manager");
    }
    checkCancelled();

    const agentDir = config.agentDir;
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.cwd, agentDir,
      noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT, appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    checkCancelled();

    const { session } = await createAgentSession({
      cwd: config.cwd, agentDir, sessionManager, resourceLoader,
      tools: undefined,
      excludeTools: ["spawn_agent"],
      shouldStopAfterTurn: (ctx) => {
        if (ctx.message.stopReason !== "toolUse") return false;
        const count = ctx.newMessages.filter(m => m.role === "assistant").length;
        if (count < (config.maxTurns ?? 10)) return false;
        stoppedByTurnBudget = true;
        return true;
      },
    });
    childSession = session;

    abortListener = () => { void childSession!.abort()?.catch(() => {}); };
    controller.signal.addEventListener("abort", abortListener, { once: true });
    checkCancelled();

    await childSession.bindExtensions({});
    checkCancelled();

    const unsubscribe = childSession.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        process.send?.({ type: "tool_call", agentId, name: event.toolName } satisfies WorkerMessage);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalStopReason = event.message.stopReason;
        if ("errorMessage" in event.message && typeof event.message.errorMessage === "string") {
          finalErrorMessage = event.message.errorMessage;
        }
        finalAssistantText = extractText(event.message.content);
      }
    });

    try {
      await childSession.prompt(`TASK\n${task}`, {
        expandPromptTemplates: false, source: "extension",
      });
    } finally {
      unsubscribe();
    }

    checkCancelled();

    if (finalStopReason === "error") {
      finalize({ type: "error", agentId, message: finalErrorMessage || "Agent error", reason: "error" });
      return;
    }
    if (finalStopReason === "aborted") {
      finalize({ type: "error", agentId, message: "Agent aborted", reason: "aborted" });
      return;
    }

    const truncated = finalStopReason === "length" || stoppedByTurnBudget;
    let output = finalAssistantText || "(no output)";
    if (finalStopReason === "length") output = `[Output truncated]\n${output}`;
    if (stoppedByTurnBudget) output = `[Max turns reached]\n${output}`;
    output = truncateOutput(output, 50 * 1024, 500);

    finalize({
      type: "result", agentId, output, sessionPath, truncated,
    });

  } catch (err) {
    if (err instanceof CancelError) {
      finalize({ type: "error", agentId, message: "Cancelled", reason: "cancelled" });
    } else {
      finalize({ type: "error", agentId, message: err instanceof Error ? err.message : String(err), reason: "error" });
    }
  } finally {
    currentController = undefined;
    abortListener = undefined;
  }
}

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a headless subagent. Complete the assigned task without asking the user for input.",
  "",
  "Your last message must summarize:",
  "- Whether the task succeeded or failed, and why.",
  "- Specific evidence: file paths, code snippets, search results, or error details.",
  "",
  "If critical information is missing, explain what is missing.",
].join("\n");

function extractText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is ContentBlock & { text: string } => c.type === "text" && typeof c.text === "string")
    .map(c => c.text).join("\n");
}

function truncateOutput(text: string, maxBytes: number, maxLines: number): string {
  const totalLines = text.split("\n").length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  const markers: string[] = [];
  if (totalLines > maxLines) {
    markers.push(`[Truncated: ${totalLines} lines total]`);
  }
  if (totalBytes > maxBytes) {
    markers.push(`[Truncated: ${(totalBytes / 1024).toFixed(1)} KB total]`);
  }
  if (markers.length === 0) return text;

  const suffix = markers.join("\n");
  const suffixBytes = Buffer.byteLength("\n" + suffix, "utf-8");
  // 预算极小（仅测试场景）：按字符截 suffix
  if (maxBytes <= suffixBytes) {
    let truncated = "";
    for (const ch of "\n" + suffix) {
      const next = truncated + ch;
      if (Buffer.byteLength(next, "utf-8") > maxBytes) break;
      truncated = next;
    }
    return truncated;
  }

  const headBytes = maxBytes - suffixBytes;
  let lines = text.split("\n");
  if (totalLines > maxLines) lines = lines.slice(0, maxLines);

  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const sep = result ? "\n" : "";
    const full = result + sep + lines[i];
    if (Buffer.byteLength(full, "utf-8") <= headBytes) {
      result = full;
      continue;
    }
    // 整行放不下：逐字符累积
    let partial = result ? result + sep : "";
    for (const ch of lines[i]) {
      const next = partial + ch;
      if (Buffer.byteLength(next, "utf-8") > headBytes) break;
      partial = next;
    }
    result = partial;
    break;
  }

  return result + "\n" + suffix;
}
```

### 3.3 SubAgentConfig

```typescript
interface SubAgentConfig {
  cwd: string;
  agentDir: string;
  parentSession?: string;
  sessionDir: string;
  maxTurns?: number;
}
```

---

## 四、IPC 协议

```typescript
type ParentMessage =
  | { type: "run"; agentId: string; task: string; config: SubAgentConfig }
  | { type: "cancel" };

type WorkerMessage =
  | { type: "tool_call"; agentId: string; name: string }
  | { type: "result"; agentId: string; output: string; sessionPath: string; truncated: boolean }
  | { type: "error"; agentId: string; message: string; reason: "cancelled" | "error" | "aborted" };
```

已移除 `toolCallCount` 和 `tokens`——Phase 2 再加。

---

## 五、AgentManager

`manager.ts`。只有一个工具：`spawn_agent`。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  try {
    const result = await this._runtime.run(
      params.task as string,
      this._buildConfig(),
      signal,
      (toolName) => {
        onUpdate?.({
          content: [{ type: "text", text: `Subagent: ${toolName}` }],
          details: {},
        });
      },
    );
    return {
      content: [{ type: "text", text: result.output }],
      details: { sessionPath: result.sessionPath, truncated: result.truncated },
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Subagent failed: ${err instanceof Error ? err.message : String(err)}` }],
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
},
```

### Main Agent System Prompt 追加

```text
## Sub-agents

You can spawn sub-agents via the spawn_agent tool. Each sub-agent is an isolated pi instance
with full tools. spawn_agent is BLOCKING — it waits for the sub-agent to finish.

- Spawn multiple agents in parallel when tasks are independent.
- The `task` parameter MUST include ALL context the sub-agent needs.
- When a sub-agent fails or produces truncated output, TELL the user.
```

---

## 六、改动清单

| 文件 | 改动 |
|---|---|
| `core/subagent/protocol.ts` | **新建** |
| `core/subagent/runtime.ts` | **新建** |
| `core/subagent/entry.ts` | **新建** |
| `core/subagent/manager.ts` | **新建** |
| `core/agent-session.ts` | 改 — 注入 spawn_agent + system prompt + dispose → shutdown |

---

## 七、测试清单

### 7.1 单元测试（mock fork）

| # | 测试 |
|---|---|
| 1 | run → result（output + sessionPath + truncated） |
| 2 | 并行 3 × run → 全部 result |
| 3 | length → truncated=true |
| 4 | turn budget → truncated=true |
| 5 | stopReason=error + errorMessage → error |
| 6 | stopReason=aborted → error reason=aborted |
| 7 | cancel → error reason=cancelled |
| 8 | 并发上限 → throw |
| 9 | excludeTools → 无 spawn_agent |
| 10 | finalize 幂等 |
| 11 | 并发 run 的 progress 各自归属（不互相覆盖） |
| 12 | shutdown → 所有 pending run() reject |
| 13 | abort 注册竞态：初始 signal.aborted 检查后立刻 abort → 仍发 cancel IPC |
| 14 | truncateOutput：行数+字节数同时超限 → 标记各出现一次，不重复 |
| 15 | truncateOutput：UTF-8 边界切断 → Buffer.byteLength(result) <= maxBytes |
| 16 | truncateOutput：单行超长（中文/emoji）→ 保留正文前缀，byteLength <= maxBytes |
| 17 | truncateOutput：maxBytes 极小（小于 suffix 长度）→ 按字符截 suffix，不超限 |

### 7.2 进程级回归

| # | 测试 |
|---|---|
| 18 | 正常 result → worker disconnect, 父端不 kill |
| 19 | 超时 → finalize + terminate（SIGTERM → SIGKILL） |
| 20 | SIGTERM 后 worker 退出 → killTimer 被 exit handler 清除，不 SIGKILL |
| 21 | abort → 父 send cancel → worker 回 error → finalize, 无 kill |
| 22 | abort-grace 内 worker 未回 IPC → 父 kill |
| 23 | worker 异常 exit → error（不 kill） |
| 24 | fork 失败 / send 失败 → error |
| 25 | worker error 事件 → error |
| 26 | 初始化 hang → 父超时杀 |
| 27 | shutdown → 所有活跃 worker SIGKILL + reject |
| 28 | dev 启动（entry.ts + tsx） |
| 29 | built 启动（entry.js） |

### 7.3 Smoke（tmux + faux provider）

| # | 测试 |
|---|---|
| 30 | 前台 spawn → main LLM 看到结果 |
| 31 | 并行 → 全部结果 |

---

## 八、Phase 1 vs Phase 2

| | Phase 1 | Phase 2 |
|---|---|---|
| 工具 | spawn_agent（1 个） | + list / wait / close / send_message |
| 模式 | 前台阻塞 | + 后台 |
| 进度 | 当前 tool 名 | + 统计（toolCallCount / tokens） + session 导航 |
| agent 配置 | 内置 | ~/.pi/agent/agents/*.md |
| 模型 | settings 默认 | 每 agent 可指定 |
| 工具集 | 全部（- spawn_agent） | 白名单 |
| 递归 | 禁止 | 可配置 |
