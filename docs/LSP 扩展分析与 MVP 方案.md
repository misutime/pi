# LSP 扩展分析与 MVP 方案

> 基于 omp (oh-my-pi) LSP 实现的逆向分析，给出原版 pi 的 MVP 实现逻辑与后续优化路线。

---

## 一、omp LSP 架构总览

omp 的 LSP 实现位于 `packages/coding-agent/src/lsp/`，分为 **6 层**：

```
┌─────────────────────────────────────────────────────────┐
│  LspTool (index.ts)                                     │
│  工具入口: diagnostics, definition, rename, hover 等     │
│  读写分类、审批、超时管理、输出格式化                        │
├─────────────────────────────────────────────────────────┤
│  Writethrough (index.ts 后半)                            │
│  formatOnWrite + diagnosticsOnWrite 的写穿透              │
│  带 deferred 通道处理慢服务器，支持 batch                    │
├─────────────────────────────────────────────────────────┤
│  Client (client.ts) ─── 约 600 行                        │
│  JSON-RPC over stdio: initialize → 消息帧 → reader 循环   │
│  文件同步 (didOpen/Change/Save), 等待诊断, 请求/通知        │
├─────────────────────────────────────────────────────────┤
│  Config (config.ts + defaults.json)                      │
│  配置合并: 项目 lsp.json → ~/.omp → 内置 40+ server 定义    │
│  自动检测: rootMarker 存在 + 二进制可解析 → 注册             │
│  本地二进制发现: node_modules/.bin, .venv/bin, vendor/bin    │
├─────────────────────────────────────────────────────────┤
│  Types (types.ts)        │ Utils (utils.ts)              │
│  LSP 协议完整类型定义      │ URI↔path, 格式化, 语言检测      │
│  Edits (edits.ts)        │ Clients/ (biome, swiftlint)    │
│  TextEdit/WorkspaceEdit   │ 非标准 LSP 的 linter 适配       │
└─────────────────────────────────────────────────────────┘
```

---

## 二、核心流程详解

### 2.1 服务发现与启动 (`config.ts` + `defaults.json`)

```
loadConfig(cwd)
  ├─ 加载 defaults.json（内置 40+ 语言服务器定义）
  ├─ 遍历配置源（优先级从低到高）：
  │   1. ~/lsp.json / ~/.lsp.json
  │   2. ~/.omp/agent/lsp.*  →  ~/.claude/lsp.* 等用户目录
  │   3. .omp/lsp.*  →  .claude/lsp.* 等项目目录
  │   4. cwd/lsp.json / cwd/.lsp.json（项目根，最高优先级）
  │   5. Plugin / marketplace LSP 配置
  ├─ 合并规则：高优先级覆盖低优先级的同名字段
  ├─ 如果无用户覆盖 → 自动检测模式：
  │   对每个内置 server：
  │     ├─ hasRootMarkers(cwd, config.rootMarkers) → 项目有标记文件？
  │     └─ resolveCommand(command, cwd) → 二进制可找到？
  │         ├─ 先查本地 bin：node_modules/.bin, .venv/bin, vendor/bundle/bin...
  │         └─ 再查全局 $PATH
  └─ 返回 { servers: 可用服务, idleTimeoutMs }
```

**rootMarker 示例**：
| 语言 | 标记文件 |
|------|----------|
| TypeScript | `package.json`, `tsconfig.json` |
| Rust | `Cargo.toml`, `rust-analyzer.toml` |
| Python | `pyproject.toml`, `requirements.txt` |
| Go | `go.mod`, `go.work` |
| Nix | `flake.nix`, `shell.nix` |

### 2.2 客户端生命周期 (`client.ts`)

```
┌─ getOrCreateClient(config, cwd) ──────────────────────┐
│                                                        │
│  key = "command:cwd"  (全局单例池)                       │
│  ├─ 已存在 → 返回复用                                    │
│  ├─ 另一协程创建中 → 等待并复用                            │
│  └─ 新建：                                              │
│                                                         │
│  1. ptree.spawn([cmd, ...args], { cwd, stdin: "pipe" }) │
│     ↓                                                    │
│  2. startMessageReader(client) ─── 后台循环              │
│     ├─ ReadableStream reader 读 stdout                  │
│     ├─ MessageFramer 解析 Content-Length header          │
│     ├─ JSON.parse 消息体                                 │
│     └─ 路由：                                           │
│         ├─ 有 method 无 id → server notification        │
│         │   ├─ textDocument/publishDiagnostics           │
│         │   │   → 存入 client.diagnostics Map            │
│         │   └─ $/progress                                │
│         │       → begin/end → 追踪 projectLoaded         │
│         ├─ 有 method 有 id → server request (需回答)      │
│         │   ├─ workspace/configuration                  │
│         │   ├─ workspace/applyEdit                      │
│         │   └─ window/showMessageRequest → null          │
│         └─ 有 id 无 method → response (匹配 pending)      │
│                                                          │
│  3. sendRequest("initialize", {                          │
│       processId, rootUri, capabilities,                  │
│       workspaceFolders, initializationOptions             │
│     })                                                    │
│     → 收到 server capabilities                            │
│                                                          │
│  4. sendNotification("initialized", {})                   │
│     → client.status = "ready"                             │
│     → 注册到 global clients map                           │
│                                                          │
│  5. 进程退出 → 自动清理                                    │
│     ├─ proc.exited.then() → delete from clients           │
│     ├─ reject 所有 pending requests                       │
│     └─ 记录 stderr 到 error message                       │
└──────────────────────────────────────────────────────────┘
```

**关键实现细节**：

- **消息帧**：`Content-Length: N\r\n\r\n{body}` — omp 使用 `MessageFramer` 支持不完整帧的累积
- **请求超时**：默认 30s，有 caller signal 时不另加计时器
- **writeQueue**：串行化所有 stdout 写入，避免并发写入交叉
- **flush 保护**：`sink.flush()` + `AbortSignal` 竞速，避免卡在无法排出的管道上
- **初始化失败负缓存**：3 分钟内不重试已失败的 server

### 2.3 文件同步流程

```
didOpen (首次)
  → ensureFileOpen: 读取文件内容 → sendNotification("textDocument/didOpen", {uri, languageId, version:1, text})
  → client.openFiles.set(uri, {version:1, languageId})
  → 文件级互斥锁防止并发 open/change

didChange (编辑后、写盘前)
  → syncContent: 清除旧诊断 → version++ → sendNotification("textDocument/didChange", {uri, version, contentChanges: [{text}]})

didSave (写盘后)
  → notifySaved: sendNotification("textDocument/didSave", {uri})
```

### 2.4 等待诊断

```typescript
async function waitForDiagnostics(client, uri, options) {
  const { timeoutMs, signal, minVersion, expectedDocumentVersion, settleMs } = options;

  while (Date.now() - start < timeoutMs) {
    // 必须有新诊断（diagnosticsVersion > minVersion）
    const published = client.diagnostics.get(uri);
    if (!published || client.diagnosticsVersion <= minVersion) continue;

    // Server 返回了精确的文档版本 → 立即可靠
    if (published.version === expectedDocumentVersion) return published.diagnostics;

    // 版本不匹配：等待 settle 窗口确保没有更新的发布
    if (published !== settledRef) { settledRef = published; settledAt = Date.now(); }
    else if (Date.now() - settledAt >= settleMs) return published.diagnostics;

    await sleep(100ms);
  }
}
```

### 2.5 写穿透 (Writethrough)

```
runLspWritethrough(dst, content, cwd, options)
  │
  ├─ captureDiagnosticVersions() ← 记录 syncing 之前的版本基线
  │
  ├─ [customFormatter?] 写盘 → 用 linter CLI 格式化 → 重新写盘 → sync 到 LSP
  │
  └─ [LSP 路径]
      ├─ 1. syncFileContent(原始内容) → didOpen/didChange
      ├─ 2. formatContent() → textDocument/formatting → 在内存中应用 TextEdit
      ├─ 3. 如果格式化后变了 → syncFileContent(格式化后)
      ├─ 4. 写盘 → notifyWorkspaceWatchedFiles()
      ├─ 5. captureOpenFileVersions() ← 记录文档版本（用于诊断匹配）
      └─ 6. notifyFileSaved() → didSave

  等待诊断（两阶段）：
      ├─ 内联阶段（500ms）：
      │   ├─ 精确版本匹配 → 立即返回
      │   └─ 未匹配但 settle → 返回
      └─ 慢服务器 → deferred 通道：
          └─ 后台 12s 等待 → onDeferredDiagnostics() 延迟注入
```

### 2.6 LSP 工具动作全集

| 动作 | 说明 | 读写 | 特殊处理 |
|------|------|------|----------|
| `diagnostics` | 诊断（单文件/glob/workspace） | read | workspace 模式调用 CLI 命令（tsc --noEmit 等） |
| `definition` | 转到定义 | read | 等待 projectLoaded，位置+符号 解析 |
| `type_definition` | 转到类型定义 | read | 同上 |
| `implementation` | 转到实现 | read | 同上 |
| `references` | 查找引用 | read | 限制 50 条，带 context，2 次重试 |
| `hover` | 悬浮信息 | read | 提取 markdown/plaintext |
| `symbols` | 文档/工作区符号 | read | workspace 限制 200 条，dedupe |
| `rename` | 重命名符号 | **write** | 默认 apply，apply:false 预览 |
| `rename_file` | 重命名文件+更新引用 | **write** | 发 willRenameFiles/didRenameFiles |
| `code_actions` | 快速修复/重构 | **write** | apply:true 时应用单个 action |
| `status` | 服务器状态 | read | 列出配置/已启动/未启动 |
| `capabilities` | 服务器能力 | read | 显示 serverCapabilities |
| `reload` | 重启服务器 | **write** | rust-analyzer 用 reloadWorkspace |
| `request` | 原始 LSP 请求 | read | 逃逸舱口 |

---

## 三、MVP 实现方案

### 3.1 目标

用最小代码量让 pi 具备基本 LSP 能力：**诊断、跳转定义、悬浮信息**。

### 3.2 文件结构

```
pi/lsp/
├── types.ts          # 精简 LSP 类型
├── client.ts         # 进程管理 + JSON-RPC 通信（核心，约 200 行）
├── config.ts         # 语言→服务器硬编码映射
├── tool.ts           # Agent 工具注册
└── utils.ts          # path↔uri, 语言 ID 检测
```

### 3.3 类型定义 (`types.ts`)

只定义 MVP 需要的类型：

```typescript
export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface Diagnostic {
  range: Range;
  severity?: 1 /*error*/ | 2 /*warning*/ | 3 /*info*/ | 4 /*hint*/;
  message: string;
  source?: string;
  code?: string | number;
}
export interface Location { uri: string; range: Range; }
export interface Hover {
  contents: { kind: "plaintext" | "markdown"; value: string } | string;
}
export interface TextEdit { range: Range; newText: string; }

// JSON-RPC 消息类型
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface ServerConfig {
  command: string;
  args?: string[];
  fileTypes: string[];
  rootMarkers: string[];
  initOptions?: Record<string, unknown>;
}
```

### 3.4 配置 (`config.ts`)

硬编码几个最常用服务器，不读文件，只做自动检测：

```typescript
import * as path from "node:path";
import * as fs from "node:fs";

const BUILTIN_SERVERS: Record<string, ServerConfig> = {
  "typescript-language-server": {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
  },
  "rust-analyzer": {
    command: "rust-analyzer",
    args: [],
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
  },
  "pyright": {
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "requirements.txt"],
  },
  "gopls": {
    command: "gopls",
    args: ["serve"],
    fileTypes: [".go"],
    rootMarkers: ["go.mod", "go.work"],
  },
};

function hasRootMarker(cwd: string, markers: string[]): boolean {
  return markers.some(marker => fs.existsSync(path.join(cwd, marker)));
}

function which(command: string): string | null {
  // 用 node `which` 或 $PATH 查找
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command]);
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

export function getServerForFile(cwd: string, filePath: string): ServerConfig | null {
  const ext = path.extname(filePath).toLowerCase();
  for (const config of Object.values(BUILTIN_SERVERS)) {
    if (!config.fileTypes.includes(ext)) continue;
    if (!hasRootMarker(cwd, config.rootMarkers)) continue;
    if (!which(config.command)) continue;
    return config;
  }
  return null;
}
```

### 3.5 客户端 (`client.ts`) — 核心

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";

const LSP_REQUEST_TIMEOUT_MS = 10_000;

function fileToUri(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (process.platform === "win32") {
    return `file:///${resolved.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1%3A")}`;
  }
  return `file://${resolved}`;
}

function frameMessage(json: string): Buffer {
  const body = Buffer.from(json, "utf-8");
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "utf-8"), body]);
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class LspClient {
  #proc: ChildProcess;
  #pending = new Map<number | string, PendingRequest>();
  #nextId = 1;
  #buffer = "";
  #contentLength: number | null = null;
  diagnostics = new Map<string, Diagnostic[]>(); // uri → diagnostics

  private constructor(proc: ChildProcess) {
    this.#proc = proc;
    this.#startReader();
  }

  static async create(config: ServerConfig, cwd: string): Promise<LspClient> {
    const proc = spawn(config.command, config.args ?? [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    proc.on("error", () => { /* handled by exit handler */ });

    const client = new LspClient(proc);

    // Initialize
    const rootUri = fileToUri(cwd);
    const result = await client.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: cwd,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
      },
      initializationOptions: config.initOptions ?? {},
      workspaceFolders: [{ uri: rootUri, name: path.basename(cwd) }],
    });

    // 发送 initialized notification
    client.notify("initialized", {});
    return client;
  }

  // === 请求/通知 ===

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const msg = frameMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${LSP_REQUEST_TIMEOUT_MS}ms`));
      }, LSP_REQUEST_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      this.#proc.stdin!.write(msg); // write 是异步的，但写入小 buffer 通常不会阻塞
    });
  }

  notify(method: string, params?: unknown): void {
    const msg = frameMessage(JSON.stringify({ jsonrpc: "2.0", method, params }));
    this.#proc.stdin!.write(msg);
  }

  // === 文件操作 ===

  async didOpen(filePath: string): Promise<void> {
    const uri = fileToUri(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const languageId = path.extname(filePath).replace(".", "");
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  // === 高级 API ===

  async diagnostics(filePath: string, timeoutMs = 5000): Promise<Diagnostic[]> {
    const uri = fileToUri(filePath);
    // 清除旧诊断，触发 server 重新计算
    this.diagnostics.delete(uri);

    await this.didOpen(filePath);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const diags = this.diagnostics.get(uri);
      if (diags !== undefined) return diags;
      await new Promise(r => setTimeout(r, 100));
    }
    return [];
  }

  async definition(filePath: string, line: number, character: number): Promise<Location[]> {
    const uri = fileToUri(filePath);
    await this.didOpen(filePath);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    const locations = Array.isArray(result) ? result : [result];
    return locations.filter((loc: any) => loc && "uri" in loc && "range" in loc) as Location[];
  }

  async hover(filePath: string, line: number, character: number): Promise<string | null> {
    const uri = fileToUri(filePath);
    await this.didOpen(filePath);
    const result = await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    }) as Hover | null;
    if (!result) return null;
    if (typeof result.contents === "string") return result.contents;
    if ("value" in result.contents) return result.contents.value;
    return null;
  }

  shutdown(): void {
    this.notify("shutdown");
    this.#proc.kill();
  }

  // === 内部 ===

  #startReader(): void {
    const rl = createInterface({ input: this.#proc.stdout!, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      // 解析 Content-Length header
      if (line.startsWith("Content-Length:")) {
        this.#contentLength = parseInt(line.split(":")[1].trim(), 10);
        this.#buffer = "";
        return;
      }

      // 空行 = header 结束，body 在下一行
      if (line === "" && this.#contentLength !== null) {
        return; // 等待 body
      }

      // 积累 body
      this.#buffer += line;

      // 检查 body 是否完整
      if (this.#contentLength !== null && Buffer.byteLength(this.#buffer, "utf-8") >= this.#contentLength) {
        try {
          const message: JsonRpcResponse | JsonRpcNotification = JSON.parse(this.#buffer);
          this.#handleMessage(message);
        } catch {
          // 忽略解析错误
        }
        this.#contentLength = null;
        this.#buffer = "";
      }
    });
  }

  #handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Server notification
    if ("method" in message) {
      if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as any;
        this.diagnostics.set(params.uri, params.diagnostics);
      }
      return;
    }

    // Response to our request
    if ("id" in message && message.id != null) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(new Error(`LSP error: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }
}
```

> **注意**：上面的 `createInterface` 逐行读取方案是**最简实现**，适合 MVP。但它有一个问题：LSP 消息的 body 可能包含换行符（多行 JSON），而 `createInterface` 在 `\r\n` 或 `\n` 处分隔。**更健壮的实现应该直接操作底层 buffer**，按 `Content-Length` 字节数精确截取。omp 使用 `MessageFramer` + `ReadableStream` reader 来解决这个问题。MVP 之后这是一个必须修的 bug。

### 3.6 工具注册 (`tool.ts`)

```typescript
import { getServerForFile } from "./config";
import { LspClient } from "./client";
import type { Diagnostic, Location } from "./types";

const clients = new Map<string, LspClient>(); // key: command:cwd

function getClientKey(config: ServerConfig, cwd: string): string {
  return `${config.command}:${cwd}`;
}

async function getOrCreateClient(cwd: string, filePath: string): Promise<LspClient | null> {
  const config = getServerForFile(cwd, filePath);
  if (!config) return null;

  const key = getClientKey(config, cwd);
  let client = clients.get(key);
  if (!client) {
    client = await LspClient.create(config, cwd);
    clients.set(key, client);
  }
  return client;
}

function formatDiagnostics(diags: Diagnostic[], filePath: string): string {
  if (diags.length === 0) return "No issues found.";
  const severityLabels: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" };
  return diags
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
    .map(d => {
      const sev = severityLabels[d.severity ?? 2];
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      return `  ${filePath}:${line}:${col} [${sev}] ${d.message}`;
    })
    .join("\n");
}

function formatLocations(locs: Location[]): string {
  if (locs.length === 0) return "No definitions found.";
  return locs
    .map(loc => {
      const line = loc.range.start.line + 1;
      const col = loc.range.start.character + 1;
      return `  ${loc.uri}:${line}:${col}`;
    })
    .join("\n");
}

export async function executeLsp(params: {
  action: string;
  file: string;
  line?: number;
  column?: number;
  cwd: string;
}): Promise<string> {
  const { action, file, line, column, cwd } = params;
  const client = await getOrCreateClient(cwd, file);
  if (!client) return `No language server available for ${file}`;

  switch (action) {
    case "diagnostics":
      return formatDiagnostics(await client.diagnostics(file), file);

    case "definition": {
      const l = (line ?? 1) - 1;
      const c = (column ?? 1) - 1;
      return formatLocations(await client.definition(file, l, c));
    }

    case "hover": {
      const l = (line ?? 1) - 1;
      const c = (column ?? 1) - 1;
      const text = await client.hover(file, l, c);
      return text ?? "No hover information available.";
    }

    default:
      return `Unknown lsp action: ${action}. Supported: diagnostics, definition, hover`;
  }
}
```

### 3.7 整体调用流程

```
用户: "lsp definition file=src/main.ts line=42 symbol=foo"

  → getServerForFile(cwd, "src/main.ts")
      ├─ .ts → 匹配 typescript-language-server 和 denols
      ├─ hasRootMarker: tsconfig.json 存在 → typescript-language-server 候选
      ├─ which("typescript-language-server") → /usr/local/bin/...  ✓
      └─ 返回 typescript-language-server config

  → LspClient.getOrCreate(config, cwd)
      ├─ clients.get("typescript-language-server:/project") → miss
      ├─ spawn("typescript-language-server", ["--stdio"])
      ├─ request("initialize", { rootUri, capabilities... })
      │   ← server capabilities
      ├─ notify("initialized")
      └─ 存入 clients map, 返回

  → client.didOpen("src/main.ts") → didOpen notification
  → client.definition("src/main.ts", 41, 2) → request("textDocument/definition", ...)
      ← [{ uri: "file:///...", range: { start: { line: 99, character: 10 }, ... } }]

  → formatLocations(locs) → "  src/utils/foo.ts:100:11"
```

---

## 四、后续优化路线

按优先级排序，每个阶段完成后 MVP 就向 omp 的水平靠近一步：

### P0 — 基础完善（从能用 → 可靠）

| 项目 | 说明 | 参考 |
|------|------|------|
| **修复消息帧解析** | `createInterface` 按行分隔会拆分多行 JSON body。改用底层 buffer + Content-Length 精确截取 | `client.ts` MessageFramer |
| **更多语言服务器** | 从 omp `defaults.json` 移植 40+ server 定义 | `defaults.json` |
| **lsp.json 配置支持** | 允许用户覆盖 server 配置，合并优先级 | `config.ts` loadConfig |
| **本地二进制发现** | 检查 `node_modules/.bin`、`.venv/bin` 等本地安装 | `config.ts` resolveCommand |

### P1 — 功能扩展（从只能查到能改）

| 项目 | 说明 | 参考 |
|------|------|------|
| **formatOnWrite** | 写文件后调用 `textDocument/formatting`，自动格式化 | `index.ts` runLspWritethrough |
| **diagnosticsOnWrite** | 写文件后等待诊断，带超时和 deferred 通道 | `index.ts` fetchDiagnosticsWithDeferral |
| **更多 action** | `references`、`rename`、`symbols`、`code_actions` | `index.ts` execute 中的各分支 |
| **didChange 增量同步** | 编辑后不发完整文件内容，发 contentChanges | `client.ts` syncContent |
| **服务器请求处理** | 响应 `workspace/configuration`、`workspace/applyEdit` 等 server 端请求 | `client.ts` handleServerRequest |

### P2 — 健壮性

| 项目 | 说明 | 参考 |
|------|------|------|
| **进程崩溃恢复** | exit handler 自动清理 + reject pending，下次调用自动重建 | `client.ts` proc.exited |
| **初始化失败负缓存** | 初始化失败的 server 3 分钟内不重试 | `client.ts` INIT_FAILURE_BACKOFF |
| **AbortSignal 贯穿** | 所有操作可被取消，避免超时后仍在后台执行 | `client.ts` signal 参数 |
| **idle 回收** | 空闲超时自动关停 server，节省资源 | `client.ts` setIdleTimeout |
| **文件级互斥锁** | 防止并发的 didOpen/didChange 版本冲突 | `client.ts` fileOperationLocks |

### P3 — 高级特性

| 项目 | 说明 | 参考 |
|------|------|------|
| **linter 适配** | 像 Biome、Ruff 这种非标准 LSP 或 CLI 工具 | `clients/` 目录 |
| **workspace/applyEdit** | 支持 server 发起文件修改（rust-analyzer SSR 等） | `client.ts` handleApplyEditRequest |
| **写穿透 batch** | 批量写文件后统一等待诊断，减少往返 | `index.ts` LspWritethroughBatch |
| **rust-analyzer 就绪检测** | 等待 rust-analyzer workspace 真正可用（内部有 settle 窗口） | `client.ts` waitForRustAnalyzerWorkspace |
| **lspmux 多路复用** | 多个同类型 server 共享一个代理进程 | `lspmux.ts` |

---

## 五、与 omp 的关键差异对照

| 维度 | omp | MVP |
|------|-----|-----|
| 配置 | 多层合并 (defaults → user → project → plugin) | 硬编码 5 个 server |
| 启动 | 并行 warmup + lazy init | 首次调用时同步创建 |
| 消息帧 | MessageFramer（buffer 级精确截取） | createInterface 逐行（多行 JSON 有 bug） |
| 客户端池 | `Map<command:cwd, LspClient>` + 锁 | 同 |
| 请求超时 | caller signal + 30s 默认 | 写死 10s |
| 诊断等待 | version 基线 + settle 窗口 + deferred | 简单的轮询等待 |
| 文件同步 | didOpen/Change/Save 完整链路 | 仅 didOpen |
| 写穿透 | format + diagnostics + deferred + batch | 无 |
| Server 请求 | 响应 configuration/applyEdit | 无 |
| 错误处理 | 负缓存、重试、reader 崩溃检测 | 基础 try/catch |
