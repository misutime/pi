# ast 内置工具实现计划

日期：2026-07-14

## 0. 结论

将 `ast`（底层 ast-grep CLI，二进制名 `sg`）做成与 `fd`/`rg` 同等地位的内置工具：

```
├── find       (fd)
├── grep       (rg)
├── ast        (ast-grep / sg)
```

**原则**：

- 和 `fd`/`rg` **一模一样的模式**：自动下载、自动缓存、离线 fallback、Termux 指引。
- 复用 `plan-lsp-client` 分支上已有的 `StructuralSearch` 封装和 `TOOLS.sg` 配置，去掉 LSP/SemanticIndex 耦合。
- 不做 LSP、不做 semantic-index、不做 `go_to_definition` 等语义工具 — 它们属于另一个计划。
- `ast` 是一个**只读的结构化代码搜索工具**（read-only structural code search），底层为 ast-grep CLI。
- 职责：比 grep 更准确地定位代码结构。不写文件。修改走 `ast → read → edit` 流程。
- 不承诺完整 ast-grep 能力（rule engine、codemod、自动重构），不承诺语义分析。

### 0.1 关于 rewrite 的决策

**当前**：`StructuralSearch.rewrite()` 已删除。

**理由**：ast 作为 core tool 的职责是比 grep 更准确地回答「哪里有这种代码结构」，随后由现有 `read` / `edit` 完成修改。边界清晰，符合 agent 可审计工作流。

删除的收益：
- 避免未验证、未测试的死代码——rewrite() 没有 tool schema、没有调用方、没有契约。
- 避免绕过 `edit` 的差异展示、失败语义和文件修改队列。
- 防止模型把「找到了匹配」误当成「可以安全全局替换」。
- 避免直接落盘时的部分成功、跨文件失败、取消中断、忽略规则不一致、生成代码误改等复杂状态。
- 减少 core tool 的参数和提示词负担。对大多数任务，`ast → read → edit` 已足够。

保留的代价：
- 大规模机械改造更慢、更贵：例如 500 个旧 API 迁移到新 API，模型需要多轮读取和编辑。
- `edit` 基于文本 old/new，面对格式差异、同模式在多文件中重复时不如 AST rewrite 稳定。
- Agent 失去「按结构批量变换」能力，只能把 AST 当高级定位器。

**未来**：只有出现高频、大批量、语法机械迁移需求时，才做独立的 preview-first `ast_transform` tool，不塞回 `ast`。

推荐的两步接口：

```typescript
// 第一步：预览，不落盘
ast_transform({
  pattern: "oldApi($$$ARGS)",
  rewrite: "newApi($$$ARGS)",
  path: ".",
  language: "typescript",
  globs: ["src/**/*.ts", "!**/*.test.ts"],
  mode: "preview",
});
// 返回：命中文件数、匹配数、每个文件的 unified diff、截断与跳过说明

// 第二步：显式应用
ast_transform({
  pattern: "oldApi($$$ARGS)",
  rewrite: "newApi($$$ARGS)",
  path: ".",
  language: "typescript",
  globs: ["src/**/*.ts"],
  mode: "apply",
  expectedMatchCount: 500,
});
// apply 需要：与 edit 相同的文件修改队列与 diff 输出；
// expectedMatchCount 防止扫描结果变化后误改；
// 默认尊重 ignore/glob；可取消；明确报告已修改/未修改文件
```

## 1. 涉及文件

### 1.1 tools-manager.ts — 新增 sg 二进制管理

**文件**: `packages/coding-agent/src/utils/tools-manager.ts`

改动：

1. `TOOLS` 记录新增 `sg` 配置（从 `plan-lsp-client` 分支提取）：

```typescript
sg: {
    name: "ast-grep",
    repo: "ast-grep/ast-grep",
    binaryName: "ast-grep",         // GitHub release 中的二进制名
    systemBinaryNames: ["sg", "ast-grep"],  // PATH 中查找的命令名
    tagPrefix: "",
    getAssetName: (_version, plat, architecture) => {
        // ast-grep release assets 命名格式: app-{target}.zip（无版本号）
        if (plat === "darwin") {
            return `app-${architecture === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.zip`;
        }
        if (plat === "linux") {
            return `app-${architecture === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu.zip`;
        }
        if (plat === "win32") {
            return `app-${architecture === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.zip`;
        }
        return null;
    },
},
```

2. `TERMUX_PACKAGES` 新增 `sg: "ast-grep"`。
3. 所有 `"fd" | "rg"` 类型声明扩展为 `"fd" | "rg" | "sg"`：
   - `ensureTool(tool: "fd" | "rg" | "sg", ...)`
   - `getToolPath(tool: "fd" | "rg" | "sg")`
   - `downloadTool(tool: "fd" | "rg" | "sg")`
4. 注意：`sg` 下载文件名不包含版本号（`app-{target}.zip`），但 `downloadTool` 使用 `getLatestVersion` 拿到版本号后，需要构造 download URL 时正确拼接。同时 `extractedDir` 计算要适配无版本号的 asset 名。

**关键差异 vs fd/rg**：

| 项 | fd / rg | sg (ast-grep) |
|----|---------|---------------|
| 资产名版本号 | `fd-v{version}-...` | `app-{target}.zip`（**无版本号**） |
| 资产内目录结构 | 通常含版本号子目录 | 通常只有 `ast-grep` 二进制 + `README.md` |
| 系统命令名 | `fd` / `rg` 分别 | `sg` 或 `ast-grep` |
| 本地存储名 | `fd` / `rg` | `ast-grep`（即 `binaryName`） |

这些差异在 `plan-lsp-client` 的 `TOOLS.sg` 中已正确处理。`extractZipArchive` + `findBinaryRecursively` 的通用逻辑可以覆盖。

### 1.2 ast 工具目录 — 从 plan-lsp-client 移植

**目录**: `packages/coding-agent/src/core/tools/ast/`（与 `find.ts`/`grep.ts` 同级，子目录因为多文件）

从 `origin/plan-lsp-client` 移植以下文件到 `tools/ast/` 子目录：

| 文件 | 用途 | 改动 |
|------|------|------|
| `types.ts` | `Position`, `Range`, `PatternMatch` | 直接移植，不改 |
| `search.ts` | `StructuralSearch` 类（spawn sg + JSON 解析） | 保持内部 `ensureTool("sg")` 模式，和 find/grep 一致 |
| `index.ts` | 工具定义 `createAstToolDefinition` / `createAstTool` + render 辅助函数 | **新建**，参照 `find.ts`/`grep.ts` 写 |

**目录结构**：

```
packages/coding-agent/src/core/tools/
  ast/
    index.ts        # createAstToolDefinition, createAstTool, render helpers
    search.ts       # StructuralSearch 类（spawn sg）
    types.ts        # PatternMatch, Position, Range
  find.ts           # fd 工具（单文件）
  grep.ts           # rg 工具（单文件）
  bash.ts
  ...
  index.ts          # ToolName, createAllToolDefinitions 聚合
```

**关于 `StructuralSearch`**：

`plan-lsp-client` 的 `StructuralSearch` 在内部调用 `this._getSgPath()` → `ensureTool("sg")`，和 `find.ts`/`grep.ts` 在 execute 中调用 `ensureTool("fd"/"rg")` 完全一致。保留此模式，无需重构。

需确认：

- `_spawnSg` 的超时、abort、错误处理与 `find.ts`/`grep.ts` 对齐。
- `_parseSearchOutput` 正确处理 `sg --json=stream` 的 NDJSON 输出格式。

### 1.3 ast 工具定义 — 写在 `tools/ast/index.ts`

`tools/ast/index.ts` 是工具定义的入口，不额外建 `tools/ast.ts`。结构参照 `find.ts`/`grep.ts`：

```typescript
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import { StructuralSearch } from "./search.ts";
import type { PatternMatch } from "./types.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
// ... render helpers (formatAstCall, formatAstResult)

const astSchema = Type.Object({
    pattern: Type.String({
        description: "Code pattern to search with. Use $NAME for identifiers, $$$ for any nodes. E.g. 'function $NAME($$$) { $$$ }' to match all function declarations.",
    }),
    path: Type.Optional(Type.String({
        description: "File or directory to search in (default: current directory)",
    })),
    language: Type.Optional(Type.String({
        description: "Language, e.g. typescript, python, rust. Auto-detected from file extension if omitted.",
    })),
    limit: Type.Optional(Type.Number({
        description: "Maximum results (default: 100)",
    })),
});

export type AstToolInput = Static<typeof astSchema>;
const DEFAULT_LIMIT = 100;

export interface AstToolDetails {
    matchLimitReached?: number;
}

export function createAstToolDefinition(cwd: string): ToolDefinition<typeof astSchema, AstToolDetails | undefined> {
    return {
        name: "ast",
        label: "ast",
        description: `Search code by AST pattern. Returns matching code blocks with file paths, line numbers, and captured variables. Supports JS/TS, Python, Rust, Go, Java, C/C++, and more. Output is truncated to ${DEFAULT_LIMIT} results.`,
        promptSnippet: "Search code structure with AST patterns",
        parameters: astSchema,
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const { pattern, path: searchPath, language, limit } = params as AstToolInput;
            const effectiveLimit = limit ?? DEFAULT_LIMIT;

            // Ensure sg binary
            const sgPath = await ensureTool("sg", true);
            if (!sgPath) throw new Error("ast-grep (sg) is not available and could not be downloaded");
            if (signal?.aborted) throw new Error("Operation aborted");

            const search = new StructuralSearch(sgPath);

            let results: PatternMatch[];
            if (searchPath) {
                const isDir = /* check if directory */;
                if (isDir) {
                    results = await search.searchMany(searchPath, pattern, language);
                } else {
                    results = await search.search(searchPath, pattern);
                }
            } else {
                results = await search.searchMany(cwd, pattern, language);
            }

            // Apply limit, format output
            // ...
        },
        renderCall(args, theme, context) { /* ... */ },
        renderResult(result, options, theme, context) { /* ... */ },
    };
}
```

**关键设计决策**：

1. **工具名 `ast`**：简短、与 `find`/`grep` 对齐。Agent 看到的工具名就是 `ast`。
2. **`StructuralSearch` 构造函数接受 `sgPath`**：`plan-lsp-client` 的 `search.ts` 内部调用 `ensureTool`。改为构造函数注入路径，由工具层负责获取路径。这样 `StructuralSearch` 保持纯 spawn 逻辑，方便测试。
   - 或者保持现有设计（内部调用 `ensureTool`）也行，和 `find.ts`/`grep.ts` 完全一致。
   - **推荐**：保持内部 `ensureTool` 模式，和 `find`/`grep` 一字不差。

3. **`language` 参数**：单文件时 sg 根据扩展名自推断语言，无需 `-l`；目录搜索或显式覆盖时传 `-l`。不维护手写语言映射。

4. **输出格式**：参照 grep 的格式：
   ```
   file.ts:42: function login(name, pwd) {
   file.ts:58: function logout() {
   ```
   附加 captured variables 可选。

### 1.4 注册到 tools/index.ts

**文件**: `packages/coding-agent/src/core/tools/index.ts`

改动：

1. 导入 `createAstToolDefinition`。
2. `ToolName` 类型新增 `"ast"`：
   ```typescript
   export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls" | "ast";
   ```
3. `allToolNames` 新增 `"ast"`。
4. `ToolsOptions` 新增 `ast?: AstToolOptions`（如需要）。
5. `createToolDefinition` switch 新增 `"ast"` case。
6. `createTool` switch 新增 `"ast"` case（如果需要 AgentTool 包装）。
7. `createAllToolDefinitions` 新增 `ast` 条目。
8. `createReadOnlyToolDefinitions` 新增 `ast`（ast 是只读搜索工具）。
9. (可选) `createCodingToolDefinitions` 不包含 `ast`（和 grep/find 一致，只在 full/readonly 集合中）。

### 1.5 测试

**文件**: 新建 `packages/coding-agent/test/tools/ast.test.ts`

测试点：

1. `ensureTool("sg")` 在 mock 环境下返回路径。
2. `StructuralSearch.search()` 对单文件返回正确的 `PatternMatch[]`。
3. `StructuralSearch.searchMany()` 对目录递归搜索。
4. `_parseSearchOutput` 正确解析 `sg --json=stream` NDJSON 输出。
5. 超时 kill 逻辑。
6. 模式含 `$NAME` 捕获时，captures 正确填充。
7. 不支持的文件扩展名抛出错误。
8. `sg` 二进制不存在且无法下载时抛出错误。

使用 `test/suite/harness.ts` + faux provider。

### 1.6 杂项

1. **迁移脚本**：`packages/coding-agent/src/core/migrations.ts` 已有 fd/rg 迁移逻辑（`tools/` → `bin/`）。`ast-grep` 作为新增工具无需迁移逻辑，但需确认 `tools/` 目录清理时不会误删 `ast-grep`。
2. **settings.json**：`activeBuiltinTools` 支持 `"ast"` 名。`allToolNames` 更新后自动生效。
3. **CHANGELOG**：`packages/coding-agent/CHANGELOG.md` `[Unreleased]` → `### Added` → `新增 ast 内置工具，基于 ast-grep CLI 结构化代码搜索（与 find/grep 同模式）`。

## 2. 不与 LSP 耦合

`ast` 工具是**纯 sg CLI 包装**，不依赖：

- `ProcessManager`（LSP 长生命进程管理）
- `LspClient` / `LspManager`
- `SemanticIndex`
- `semantic-tools.ts`（go_to_definition 等语义工具）
- `packages/coding-agent/src/core/rpc/`

`plan-lsp-client` 分支的 `StructuralSearch` 已经剥离好了：它只用 `spawn("sg", ...)`，和 LSP 零耦合。我们只需移植 `core/tools/ast/` 目录下的文件 + `tools-manager.ts` 的 `sg` 配置。

## 3. 实现顺序

| 步骤 | 内容 | 预估复杂度 |
|------|------|-----------|
| 1 | `tools-manager.ts` 新增 `sg` 配置 + 类型扩展 | 低（照搬 plan-lsp-client） |
| 2 | 移植 `core/tools/ast/` 目录（types, search） | 低 |
| 3 | 新建 `core/tools/ast/index.ts` 工具定义 | 中（需参照 find/grep 的 execute/render 模式） |
| 4 | 注册到 `tools/index.ts`（ToolName, allToolNames, createAllToolDefinitions） | 低 |
| 5 | 测试 `test/tools/ast.test.ts` | 中 |
| 6 | 运行 `npm run check` + `just test` | 低 |

## 4. 风险和注意事项

- **ast-grep release 资产命名无版本号**：`downloadTool` 的 `extractedDir` 计算要适配。`extractedDir = join(extractDir, assetName.replace(/\.zip$/, ""))` 已正确。
- **Windows 二进制名**：`ast-grep.exe`，`tools-manager.ts` 已有 `.exe` 后缀逻辑。
- **离线模式**：已有 `PI_OFFLINE` 检查和 Termux 提示，`sg` 自然继承。
- **并发下载**：已有 `extract_tmp_*` 目录隔离，无竞态。
- **`sg` 和 `ast-grep` 命令名差异**：`systemBinaryNames: ["sg", "ast-grep"]` 覆盖两种安装方式（cargo/npm 装的是 `sg`，直接下载 release 的是 `ast-grep`）。
