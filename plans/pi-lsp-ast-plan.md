# pi LSP + sg CLI 结构化代码能力 MVP 计划

日期：2026-07-13

## 0. 结论

MVP 同时集成两类能力：

1. **LSP**：负责跨文件语义能力，例如 definition、references、hover、diagnostics。
2. **sg CLI**：负责结构化代码搜索和轻量 rewrite fallback。`sg` 是 ast-grep CLI 二进制，走 `tools-manager.ts` 自动下载，模式与现有 `fd` / `rg` 一致。

MVP **不引入 `@ast-grep/napi`**。

原因：

- `@ast-grep/napi` 默认只覆盖 JS 生态语言，不能作为 Go/Rust/Python/Java 的统一 AST 后端。
- `sg` CLI 的语言覆盖更符合 MVP 目标。
- `sg` 作为外部二进制接入，安装、安全、缓存路径与现有 `fd` / `rg` 工具一致。
- spawn 开销对 MVP 可接受。后续如果 TS/JS 高频查询出现明确性能瓶颈，再考虑把 `@ast-grep/napi` 做成可选 fast path。

## 1. 当前基线

已有能力：

| 模块 | 状态 | 位置 |
|------|------|------|
| JSON-RPC 2.0 类型 | 已有 | `packages/coding-agent/src/core/rpc/types.ts` |
| JsonRpcPeer | 已有 | `packages/coding-agent/src/core/rpc/peer.ts` |
| NodeIpcTransport | 已有 | `packages/coding-agent/src/core/rpc/transport.ts` |
| WorkerIpcTransport | 已有 | `packages/coding-agent/src/core/rpc/transport.ts` |
| SubagentRuntime | 已有 | `packages/coding-agent/src/core/subagent/runtime.ts` |
| tools-manager | 已有 | `packages/coding-agent/src/utils/tools-manager.ts`，当前管理 `fd` / `rg` |

缺失能力：

| 模块 | MVP 处理 |
|------|----------|
| `StdioJsonRpcTransport` | 新增，用于 LSP Content-Length framing |
| `ProcessManager` | 新增，管理 LSP server 长生命周期进程 |
| `LspClient` | 新增，封装 initialize / shutdown / textDocument 方法 |
| `StructuralSearch` | 新增，封装 `sg` CLI search / rewrite |
| `SemanticIndex` | 新增，统一调度 LSP 和 sg fallback |
| 语义工具 | 新增 built-in tools，接入 `_baseToolDefinitions` |

## 2. 架构原则

### 2.1 分层

```text
Agent Tool Layer
  go_to_definition / find_references / symbol_hover / file_symbols / workspace_symbols / diagnostics

Semantic API
  definition() / references() / hover() / outline() / findSymbol() / diagnostics()

Backends
  LSP Client                         sg CLI StructuralSearch
  initialize / textDocument/*        sg run --json / sg run --replace (-r)

RPC
  JsonRpcPeer

Transport
  StdioJsonRpcTransport

Process
  ProcessManager for LSP servers
  tools-manager for sg binary discovery/download
```

### 2.2 所有权

- `ProcessManager` 拥有 LSP server 进程生命周期：spawn、stop、restart、idle timeout、crash state。
- `StdioJsonRpcTransport` 只绑定一个已存在的 `ChildProcess`，负责 stdin/stdout framing，不 spawn、不 kill。
- `sg` CLI 不进入 `ProcessManager`。它是短生命周期工具调用，和 `fd` / `rg` 一样通过 `ensureTool("sg")` 找到二进制后按需 spawn。
- SubAgent 继续使用现有 fork + Node IPC 路径，不迁移到 stdio。

### 2.3 查询策略

- LSP 可用时优先用 LSP。
- LSP 不可用或方法不支持时，fallback 到 `sg`。
- `diagnostics` 只来自 LSP。`sg` 不做类型检查。
- LSP 和 `sg` 都不可用时，不注册语义工具，Agent 回退到 read/grep/find/ls/edit/bash/write。

## 3. 依赖和安全策略

### 3.1 sg CLI

`sg` 通过 `tools-manager.ts` 管理，不作为 npm dependency。

需要在 `TOOLS` 中新增配置：

```typescript
// placeholder only
// sg: {
//   name: "ast-grep",
//   repo: "ast-grep/ast-grep",
//   binaryName: "sg",
//   systemBinaryNames: ["sg", "ast-grep"],
//   tagPrefix: "",
//   getAssetName(version, platform, arch) { /* map GitHub release assets */ },
// }
```

注意：

- `ensureTool("sg")` 的 key `"sg"` 是工具内部名称，不假定 GitHub Release 资产内的可执行文件名一定是 `sg`。实际 binary name 以 release asset 中的文件名为准（可能为 `ast-grep` / `ast-grep.exe`），`getAssetName` 和 `findBinaryRecursively` 负责从 archive 中提取。调用层只使用 `ensureTool("sg")` 返回的 path，不假设命令名。
- 实现前必须核对 ast-grep GitHub Releases 的实际 asset 命名，不能猜平台包名。

需要同步调整：

- `ensureTool(tool)` 类型从 `"fd" | "rg"` 扩展到包含 `"sg"`。
- `getToolPath(tool)` 类型同步扩展。
- `downloadTool(tool)` 类型同步扩展。
- Android/Termux 提示可后续补；MVP 可以 unsupported 并优雅降级。

### 3.2 npm dependency

MVP 不添加 `@ast-grep/napi`。

因此不需要：

- optional dependency 处理。
- native binding smoke。
- npm lifecycle script allowlist。
- Bun binary 内嵌 `.node` 处理。

### 3.3 LSP server

Pi 不自动安装 LSP server。

- 用户环境已有 server 时，ProcessManager 启动它。
- 测试优先使用 fake LSP server，不依赖用户本机安装。
- 如需真实 server 集成测试，可用 pinned devDependency，但不进入 production dependency。

## 4. 阶段 1：sg CLI 工具管理

目标：让 Pi 能像使用 `fd` / `rg` 一样找到或下载 `sg`。

文件：

- `packages/coding-agent/src/utils/tools-manager.ts`

占位改动：

```typescript
// placeholder only
// type ManagedToolName = "fd" | "rg" | "sg";
// export async function ensureTool(tool: ManagedToolName, silent = false): Promise<string | undefined>
// export function getToolPath(tool: ManagedToolName): string | null
```

测试逻辑：

- 本地已有 `sg` 时优先返回 PATH 中的命令。
- 本地无 `sg` 时按平台选择 release asset 并下载。
- 下载后能执行 `sg --version`。
- unsupported platform 返回 `undefined`，不崩溃。
- `PI_OFFLINE=1` 时不下载，返回 `undefined`。

## 5. 阶段 2：StdioJsonRpcTransport + ProcessManager

目标：为 LSP server 提供 stdio JSON-RPC 通道和进程生命周期管理。

### 5.1 StdioJsonRpcTransport

文件：

- `packages/coding-agent/src/core/rpc/transport-stdio.ts`

职责：

- 绑定已 spawn 的 `ChildProcess`。
- 解析 LSP `Content-Length: N\r\n\r\n{json}` framing。
- 实现现有 `RpcTransport` 接口。
- `close()` 只清理 listener 和 stdin，不 kill 进程。

占位：

```typescript
// placeholder only
export class StdioJsonRpcTransport implements RpcTransport {
  // private _child: ChildProcess;
  // private _buffer: Buffer;
  // private _handlers: Array<(message: RpcMessage) => void>;

  // constructor(child: ChildProcess) { /* store child */ }
  // start(): void { /* attach stdout/error/exit listeners */ }
  // send(message: RpcMessage): boolean { /* write Content-Length framed JSON */ }
  // onMessage(handler: (message: RpcMessage) => void): () => void
  // onClose(handler: () => void): () => void
  // onError(handler: (err: Error) => void): () => void
  // close(): void { /* remove listeners; end stdin; do not kill */ }
}
```

测试逻辑：

- 单包解析。
- 半包累积。
- 粘包拆分。
- malformed header 报错。
- close 后 send 返回 false。
- 子进程 exit 触发 onClose。

### 5.2 ProcessManager

文件：

- `packages/coding-agent/src/core/process-manager.ts`

职责：

- 按 key 复用 session 型进程。
- 处理 idle timeout。
- 处理 shutdownAll。
- 标记 crash。

占位：

```typescript
// placeholder only
type ProcessState = "starting" | "running" | "stopping" | "stopped" | "crashed";

interface ProcessKey {
  workspace: string;
  kind: "lsp" | "daemon";
  language?: string;
}

interface ManagedProcessHandle {
  readonly key: ProcessKey;
  readonly state: ProcessState;
  readonly child: ChildProcess;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  touch(): void;
}

export class ProcessManager {
  // async getOrCreate(key, factory): Promise<ManagedProcessHandle>
  // async remove(key): Promise<void>
  // async shutdownAll(): Promise<void>
}
```

测试逻辑：

- `getOrCreate` 首次创建。
- 同 key 再次调用复用进程。
- 不同 key 创建不同进程。
- idle timeout 后 stop/remove。
- crash 后 state 变为 `crashed`。
- `shutdownAll` 停止所有进程。

## 6. 阶段 3：LSP Client

文件：

- `packages/coding-agent/src/core/lsp/client.ts`
- `packages/coding-agent/src/core/lsp/types.ts`

职责：

- initialize / initialized。
- didOpen / didChange。
- definition / references / hover / documentSymbol。
- diagnostics：优先 pull diagnostics；否则缓存 `textDocument/publishDiagnostics` 通知。
- shutdown / exit。

占位：

```typescript
// placeholder only
export class LspClient {
  // constructor(peer: JsonRpcPeer, rootUri: string)
  // async initialize(): Promise<LspInitializeResult>
  // async shutdown(): Promise<void>
  // notifyDidOpen(file): void
  // notifyDidChange(file): void
  // async definition(uri, position): Promise<LspLocation[]>
  // async references(uri, position): Promise<LspLocation[]>
  // async hover(uri, position): Promise<LspHover | null>
  // async documentSymbols(uri): Promise<LspDocumentSymbol[]>
  // async diagnostics(uri): Promise<LspDiagnostic[]>
}
```

测试逻辑：

- fake LSP server 完成 initialize 流程。
- initialized 通知在 initialize response 后发送。
- didOpen / didChange 被 fake server 接收。
- definition / references / hover 返回预设结果。
- diagnostics pull model 返回结果。
- publishDiagnostics 通知更新 cache。
- shutdown 后再次请求报错。
- server crash 后 pending requests 被取消。

## 7. 阶段 4：StructuralSearch（sg wrapper）

文件：

- `packages/coding-agent/src/core/ast/search.ts`
- `packages/coding-agent/src/core/ast/types.ts`
- `packages/coding-agent/src/core/ast/patterns.ts`

职责：

- `ensureTool("sg")`。
- 文件扩展名到 `--lang` 的映射。
- spawn `sg run --json` 执行结构化搜索。
- 可选 rewrite：封装 `sg run -p <pattern> -r <replacement> -l <lang> <path>`。输出形式（完整源码 / edits / diff / 直接更新文件）等实现时用 CLI 实际行为验证后决定，不在计划中预先承诺。
- 统一解析 stdout 为 `PatternMatch[]`。

占位：

```typescript
// placeholder only
interface PatternMatch {
  filePath: string;
  range: { start: Position; end: Position };
  text: string;
  captures: Record<string, string>;
}

export class StructuralSearch {
  // async search(filePath: string, pattern: string): Promise<PatternMatch[]>
  // async searchMany(rootDir: string, pattern: string, options): Promise<PatternMatch[]>
  // async rewrite(filePath: string, pattern: string, replacement: string): Promise<unknown> // RewriteResult shape TBD after CLI verification
  // private _extToLang(filePath: string): string | undefined
  // private _spawnSg(args: string[], input?: string): Promise<{ stdout: string; stderr: string }>
}
```

命令形态：

```text
sg run --json -p <pattern> -l <lang> <path>
sg run -p <pattern> -r <replacement> -l <lang> <path>
```

注意：

- JSON 输出结构属于 ast-grep CLI，封装层必须集中解析，避免 tool 层依赖原始 shape。
- 对大结果集要有数量限制和超时。
- rewrite 在 MVP 中先作为底层能力封装，不直接暴露高级重构工具。返回值形式等实现时用 CLI 实际输出验证。

测试逻辑：

- TypeScript 函数匹配。
- Python 函数匹配。
- Rust 函数匹配。
- Go 函数匹配。
- unsupported extension 给出明确错误。
- `sg` 不可用时返回结构化不可用错误。
- timeout / non-zero exit / stderr 都有明确错误。

## 8. 阶段 5：SemanticIndex

文件：

- `packages/coding-agent/src/core/semantic/semantic-index.ts`
- `packages/coding-agent/src/core/semantic/types.ts`
- `packages/coding-agent/src/core/semantic/index.ts`

职责：

- 对 Agent tool 屏蔽 LSP / sg 差异。
- LSP 优先，sg fallback。
- 维护轻量 symbol cache。
- 文件变更后增量更新。

占位：

```typescript
// placeholder only
export class SemanticIndex {
  // constructor(lspClient: LspClient | null, search: StructuralSearch)
  // async outline(filePath: string): Promise<SymbolInfo[]>
  // async findSymbol(query: string, kind?: SymbolKind): Promise<SymbolInfo[]>
  // async definition(filePath: string, line: number, column: number): Promise<SymbolInfo | null>
  // async references(filePath: string, line: number, column: number): Promise<ReferenceInfo[]>
  // async hover(filePath: string, line: number, column: number): Promise<string | null>
  // async diagnostics(filePath: string): Promise<LspDiagnostic[]>
  // async updateFile(filePath: string): Promise<void>
}
```

策略：

- `outline`: LSP documentSymbol -> sg patterns。
- `findSymbol`: LSP workspace/symbol -> sg project search。
- `definition`: LSP definition -> same-file/import-aware sg best effort。
- `references`: LSP references -> `grep` candidates + sg confirmation。
- `hover`: LSP hover -> local structural context/comment extraction。
- `diagnostics`: LSP only。

测试逻辑：

- LSP path 命中时不调用 sg。
- LSP 不可用时 sg fallback 生效。
- diagnostics 在无 LSP 时返回空或 unavailable，不调用 sg。
- updateFile 后 cache 更新。
- unsupported file 返回空结果，不崩溃。

## 9. 阶段 6：Agent 工具注册

语义工具是 built-in tools，不走 extension 注册。

文件：

- `packages/coding-agent/src/core/tools/semantic-tools.ts`
- `packages/coding-agent/src/core/tools/index.ts`
- `packages/coding-agent/src/core/agent-session.ts`

工具：

| Tool | 后端 |
|------|------|
| `go_to_definition` | LSP -> sg fallback |
| `find_references` | LSP -> grep + sg fallback |
| `symbol_hover` | LSP -> sg/context fallback |
| `file_symbols` | LSP -> sg fallback |
| `workspace_symbols` | LSP -> sg fallback |
| `diagnostics` | LSP only |

接入点：

```typescript
// placeholder only
// 1. 扩展 ToolName 或新增 SemanticToolName。
// 2. 新增 createSemanticToolDefinitions(semanticIndex)。
// 3. AgentSession._buildRuntime() 中在 spawn_agent 附近加入 _baseToolDefinitions。
// 4. _agentToolValidation 使用现有 validateTools() 自然生效。
```

默认策略：

- 不放进 `allToolNames`。
- 只有 SemanticIndex 初始化成功时注册到 `_baseToolDefinitions`。
- Code SubAgent 创建子 AgentSession 时，其在 agent markdown 的 `tools` 中声明了语义工具名。`_buildRuntime()` 中 `_refreshToolRegistry()` 会将 `_baseToolDefinitions` 中的语义工具纳入 `_toolRegistry`，`setActiveToolsByName` 默认不主动激活它们。需要在创建 Code SubAgent 子 session 时显式将这些工具名加入 `activeToolNames`（在子 session 构造参数中传入，或通过 SubAgent entry 中读取 agentTools 后自动激活）。
- 如果语义工具未注册（SemanticIndex 不可用），`validateTools()` 会报告 agent 声明了但 missing 的工具，Code SubAgent 回退到已有工具。

测试逻辑：

- 工具注册后 `getToolDefinition()` 可见。
- code subagent tools validation 通过。
- SemanticIndex 不可用时工具不注册，validation 报 missing。
- 每个 tool 将参数转给对应 SemanticIndex 方法。

## 10. 阶段 7：Code SubAgent

新增一个可选 `code` subagent 定义。

```markdown
---
name: code
description: 精确代码分析与重构，优先使用语义工具
tools: read, edit, write, go_to_definition, find_references, symbol_hover, file_symbols, workspace_symbols, diagnostics
---

你是代码分析与重构专家。

优先使用结构化/语义工具理解代码：
- 找定义用 go_to_definition
- 查引用用 find_references
- 看类型和文档用 symbol_hover
- 看文件结构用 file_symbols
```

MVP 只提供定义模板，不做自动路由。

## 11. 实施顺序

| 阶段 | 内容 | 依赖 |
|------|------|------|
| 1 | `tools-manager.ts` 增加 `sg` | 无 |
| 2 | `StdioJsonRpcTransport` | 现有 RpcTransport |
| 3 | `ProcessManager` | 无 |
| 4 | `LspClient` | 阶段 2 + 3 |
| 5 | `StructuralSearch` | 阶段 1 |
| 6 | `SemanticIndex` | 阶段 4 + 5 |
| 7 | semantic tools 注册 | 阶段 6 |
| 8 | code subagent 模板 | 阶段 7 |

阶段 1 和阶段 2/3 可以并行。

## 12. 不在 MVP 中

- `@ast-grep/napi` fast path。
- LSP server 自动安装。
- completion / formatting / codeAction。
- 多 workspace LSP。
- symbol index 持久化。
- 自动选择 code subagent 的 router。
- 高级重构工具，例如 rename symbol、extract function、跨文件 rewrite。

## 13. 验证策略

文档之外的实现阶段需要按修改范围验证：

- 改 `tools-manager.ts`：asset-name mapping、解压、平台过滤、版本标签格式用 **fake release/download fixture** 覆盖；真实 GitHub 下载只做手动 smoke，不进常规测试。`ensureTool("sg")` 手动验证一条即可。
- 改 LSP transport/client：跑 fake LSP server tests。
- 改 StructuralSearch：跑 sg wrapper tests；如果 CI 无法下载 sg，相关下载测试 skip，但解析/错误处理可用 fake spawn 测。
- 改工具注册：跑 AgentSession/tool registry 相关 tests。
- 代码改动完成后跑 `npm run check`。
