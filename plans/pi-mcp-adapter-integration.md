# pi-mcp-adapter 内置扩展集成方案

> 2026-07-14 | 修订 2 (submodule)
> 目标：将 pi-mcp-adapter 集成为 pi 的内置扩展，同时保留从上游 (nicobailon/pi-mcp-adapter) 拉取更新、向 fork (misutime/pi-mcp-adapter) 推送修改的能力。

---

## 0. 结论

**使用 Git Submodule 将上游代码放入顶层 `vendor/pi-mcp-adapter/`，dev 入口用运行时 URL 动态加载隔离 TS 类型检查，release 用 esbuild 直接打包 vendor 目录。**

```
pi-mono/
├── .gitmodules                        →  [submodule "vendor/pi-mcp-adapter"]
├── vendor/
│   └── pi-mcp-adapter/                ←  git submodule（指向 fork）
└── packages/extensions/mcp-adapter/
    ├── package.json
    ├── src/
    │   └── index.ts                   ←  dev: 动态 import（隔离 TS 类型检查）
    └── scripts/
        └── build.mjs                  ←  esbuild: 入口 = vendor/pi-mcp-adapter/index.ts
```

---

## 1. 背景分析

### 1.1 pi-mcp-adapter 现状

| 维度 | 详情 |
|------|------|
| 上游仓库 | `https://github.com/nicobailon/pi-mcp-adapter` |
| fork 仓库 | `git@github.com:misutime/pi-mcp-adapter.git` (本地已有) |
| 当前版本 | 2.11.0 |
| 文件结构 | 扁平结构，40+ .ts 文件 |
| 入口 | `index.ts` 导出 `default function mcpAdapter(pi: ExtensionAPI)` |
| 关键依赖 | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps` |
| 运行时资源 | `app-bridge.bundle.js`（预构建 JS，由 ui-server.ts 通过 `fs.readFileSync` 提供 HTTP 服务） |

### 1.2 与 pi 仓库规则的冲突

pi-mcp-adapter 代码中存在与 pi monorepo 的 tsconfig 规则不兼容的写法：

| 规则 | pi 要求 | pi-mcp-adapter 现状 |
|------|---------|---------------------|
| `erasableSyntaxOnly` | 仅 erasable 语法 | consent-manager.ts:11 等文件使用了 parameter properties |
| No inline imports | 禁用 `await import()` 等 | commands.ts:257, types.ts:404 等位置存在 inline/dynamic imports |
| `strict: true` | 全局 strict | pi-mcp-adapter tsconfig 为 `strict: false` |

因此 vendor 代码**不能**被 root tsconfig 类型检查覆盖。

### 1.3 pi 内置扩展机制

**Dev 模式**：`loadBuiltinExtensions()` 从 `packages/extensions/<name>/src/index.ts` 加载
**Release 模式**：从 `packages/coding-agent/extensions/<name>/index.js` 加载

---

## 2. 隔离策略：为什么 vendor 放顶层

| 位置 | TS 类型检查 | check-pinned-deps | check-ts-imports |
|------|------------|-------------------|-----------------|
| `packages/extensions/mcp-adapter/vendor/` | `src/index.ts` 静态 import 会被跟进 | 需改脚本排除 vendor 目录名 | 需改脚本排除 vendor 目录名 |
| **`vendor/pi-mcp-adapter/` (顶层)** ✅ | 不在 tsconfig include 范围内，且 dev wrapper 用动态 import 隔离 | 添加 `"vendor"` 到 ignoredDirs | 添加 `"vendor"` 到 ignoredDirs |

顶层 vendor/ 与已有 `.gitignore` 不冲突（`.gitignore` 不含 `vendor/`，submodule 需要被 git 追踪）。

---

## 3. 详细设计

### 3.1 目录结构

```
pi-mono/
├── .gitmodules                         # submodule 声明
│   └── [submodule "vendor/pi-mcp-adapter"]
│       path = vendor/pi-mcp-adapter
│       url = git@github.com:misutime/pi-mcp-adapter.git
├── vendor/
│   └── pi-mcp-adapter/                 # git submodule（指向 fork）
│       ├── index.ts
│       ├── config.ts
│       ├── ... (40+ .ts 文件)
│       ├── app-bridge.bundle.js
│       ├── __tests__/
│       └── package.json               # 上游/ fork 自身的清单
└── packages/extensions/mcp-adapter/
    ├── package.json                    # 扩展清单 + 依赖（exact versions）
    ├── src/
    │   └── index.ts                    # dev 入口（动态 import）
    └── scripts/
        └── build.mjs                  # 自定义构建
```

### 3.2 Dev 入口：`src/index.ts`

运行时 URL 构造 + 动态 `import()` → TypeScript 无法静态解析模块路径 → 不类型检查 vendor/ 代码。

```typescript
// packages/extensions/mcp-adapter/src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Dynamic import via runtime URL to isolate vendor/ from root tsconfig type checking.
// The vendor code (git submodule) uses parameter properties, inline imports, and
// other patterns incompatible with this repo's erasableSyntaxOnly rules.
//
// ARCHITECTURE EXCEPTION: this file uses await import() inside the factory
// function, which would normally violate the repo's no-inline-imports rule.
// This is the minimal mechanism to load vendor/ code without letting root
// tsconfig statically follow into the submodule. No other file in src/ should
// use inline imports.
const vendorEntry = new URL(
  "../../../../vendor/pi-mcp-adapter/index.ts",
  import.meta.url,
).href;

export default async function mcpAdapter(pi: ExtensionAPI): Promise<void> {
  // Lint exclusion: architecture exception — see comment at top of file.
  // biome-ignore lint/style/noInlineImports: architecture exception for vendor isolation
  const mod = await import(vendorEntry);
  const factory = mod.default as (api: ExtensionAPI) => void;
  return factory(pi);
}
```

> 路径说明：`packages/extensions/mcp-adapter/src/index.ts` → `../../../../` → 仓库根 → `vendor/pi-mcp-adapter/index.ts`。
>
> `import.meta.url` 在 Node.js ESM 和 TypeScript `module: "Node16"` 下均可正常解析。`new URL(relative, base).href` 产生的字符串对 TS 是完全不透明的 → 不触发 vendor/ 的类型检查。
>
> **Architecture exception 已记录**：`await import()` 是本文件唯一的 inline import，目的是隔离 vendor 子模块的 TS 类型检查。AGENTS.md 的 no-inline-imports 规则对 `packages/extensions/*/src/` 仍然有效，本文件是唯一例外。

### 3.3 package.json

所有 direct dependencies 使用 **exact version**（check-pinned-deps 要求）：

```jsonc
{
  "name": "@pi/mcp-adapter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "clean": "echo 'nothing to clean'"
  },
  "dependencies": {
    "@modelcontextprotocol/ext-apps": "1.2.2",
    "@modelcontextprotocol/sdk": "1.25.1",
    "open": "10.2.0",
    "recheck": "4.5.0",
    "zod": "3.25.76"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*"
  },
  "devDependencies": {
    "esbuild": "0.25.12",
    "typescript": "5.9.3"
  }
}
```

依赖分类说明：

| 依赖 | 分类 | 原因 |
|------|------|------|
| `@earendil-works/pi-coding-agent` | peerDep | 平台提供，esbuild external |
| `@earendil-works/pi-ai` | peerDep | 平台提供，esbuild external |
| `@earendil-works/pi-tui` | peerDep | 平台提供，esbuild external |
| `@modelcontextprotocol/sdk` | dependency | 扩展独占，esbuild bundle |
| `@modelcontextprotocol/ext-apps` | dependency | 扩展独占，esbuild bundle |
| `open` | dependency | 扩展独占，esbuild bundle |
| `recheck` | dependency | 扩展独占，esbuild bundle |
| `zod` | dependency | 扩展独占，esbuild bundle |
| `typebox` | (平台提供) | 已有 external 处理 |

> 版本号说明：
> - `zod`: `3.25.76` — lockfile 中已安装版本。
> - `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, `open`, `recheck`: 以上版本号为上游 `vendor/pi-mcp-adapter/package.json` 中 `^` range 的下限。这些包尚未在 monorepo 中安装，`npm install` 后以实际解析版本为准（`check-pinned-deps` 会校验），届时更新此文档。
>
> `typebox` 不在我们的 dependencies 中 — 平台已提供，esbuild external 处理。

### 3.4 构建脚本 `scripts/build.mjs`

入口直接指向 vendor/ 目录中的 `index.ts`，绕过 `src/index.ts`（dev wrapper 只在 dev 模式下使用）：

```javascript
// packages/extensions/mcp-adapter/scripts/build.mjs
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf-8"));
const extName = pkg.name?.split("/").pop() || basename(srcDir);
const outDir = resolve(srcDir, "..", "..", "coding-agent", "extensions", extName);

// Vendor entry (git submodule at repo root)
const vendorEntry = resolve(srcDir, "..", "..", "..", "vendor", "pi-mcp-adapter", "index.ts");

// Ensure output dir exists before esbuild and file writes
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [vendorEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  mainFields: ["module", "main"],
  target: "node22",
  outfile: join(outDir, "index.js"),
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "typebox",
    "canvas",
    "*.node",
  ],
});

// Copy runtime asset: app-bridge.bundle.js
const assetSrc = join(
  srcDir, "..", "..", "..", "vendor", "pi-mcp-adapter", "app-bridge.bundle.js",
);
copyFileSync(assetSrc, join(outDir, "app-bridge.bundle.js"));

const manifest = {
  pi: { extensions: ["./index.js"] },
};
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, private: true, type: "module", ...manifest },
    null,
    2,
  ) + "\n",
);

console.log(`Built ${extName} → ${outDir}`);
```

关键修正（相比上一版）：
- `mkdirSync(outDir)` 在 `esbuild.build()` **之前**执行
- esbuild entry 直接指向 `vendor/pi-mcp-adapter/index.ts`，不经过 `src/index.ts`

### 3.5 脚本排除规则

两个检查脚本需要忽略 `vendor/` 目录：

#### `scripts/check-pinned-deps.mjs`

```diff
- const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
+ const ignoredDirectories = new Set([".git", "dist", "node_modules", "vendor"]);
```

#### `scripts/check-ts-relative-imports.mjs`

```diff
- const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
+ const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "vendor"]);
```

### 3.6 Submodule 操作

#### 3.6.1 首次添加

```bash
# 在主仓库根目录执行
git submodule add \
  git@github.com:misutime/pi-mcp-adapter.git \
  vendor/pi-mcp-adapter

# 在子仓库内配置 upstream remote（首次一次性）
cd vendor/pi-mcp-adapter
git remote add upstream https://github.com/nicobailon/pi-mcp-adapter.git
cd ../..

# 提交
git add .gitmodules vendor/pi-mcp-adapter
git commit -m "Add pi-mcp-adapter as submodule at vendor/pi-mcp-adapter"
```

#### 3.6.2 日常修改 + 推送 fork

```bash
cd vendor/pi-mcp-adapter
git checkout main                     # submodule 初始在 detached HEAD
# ... edit files ...
git add -A
git commit -m "Custom feature"
git push origin main                  # 推到 fork

# 回到 monorepo，更新 submodule 指针
cd ../..
git add vendor/pi-mcp-adapter
git commit -m "Update pi-mcp-adapter submodule"
```

#### 3.6.3 同步上游

```bash
cd vendor/pi-mcp-adapter
git checkout main
git fetch upstream
git merge upstream/main               # 解决冲突（如有）
git push origin main                  # 推到 fork

cd ../..
git add vendor/pi-mcp-adapter
git commit -m "Update pi-mcp-adapter submodule (sync upstream)"
```

#### 3.6.4 Clone / CI

```bash
# 开发环境
git clone --recursive <monorepo-url>

# 或先 clone 再初始化
git clone <monorepo-url>
cd pi
git submodule update --init --recursive
```

### 3.7 CI 改造范围

以下 workflow/job 需要 `submodules: recursive`（不仅仅是 checkout）：

| 触发条件 | 原因 |
|----------|------|
| `npm run build` | coding-agent 的 build 脚本会先跑 `build-all-extensions.mjs`，其中 `mcp-adapter` 的 build 需要 vendor/ 文件 |
| `npm run check` | `tsgo --noEmit` 需要 `src/index.ts`（不检查 vendor/），但 `check-pinned-deps` 需要 submodule 存在才不会报目录缺失 |
| `npm run test` | 仅当 mcp-adapter 有自己的 test 时才需要（暂不纳入） |
| Release binary (`build:binary`) | 需要 bundle mcp-adapter 的 release 产物 |
| Publish (`prepublishOnly` → `build` → `shrinkwrap`) | 同上 |

**所有含 `npm run build` 或 `npm run check` 的 CI job 都需要加 `submodules: recursive`。**

GitHub Actions 示例：

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      submodules: recursive
```

### 3.8 Workspace 注册

根 `package.json` 的 `workspaces` 已包含 `"packages/extensions/*"`，无需额外修改。

### 3.9 npm install

pi-mcp-adapter 依赖需要在 monorepo 级别安装：

```bash
npm install --ignore-scripts
```

`@modelcontextprotocol/sdk` 等包会被 hoist 到根 `node_modules`，esbuild bundle 时自动解析。

> Submodule 内的 `vendor/pi-mcp-adapter/package.json` 是其自身的依赖声明。这些依赖由 monorepo 的 workspace 解析提供，不在子仓库内单独 `npm install`。

---

## 4. 代码同步工作流

三个仓库之间的关系：

```
nicobailon/pi-mcp-adapter (上游)
        │
        │ git fetch upstream + git merge upstream/main (在 vendor/ 子仓库内)
        ▼
misutime/pi-mcp-adapter (fork)  ←──  vendor/ 子仓库的 origin
        │
        │ git submodule add (首次) / git submodule update (后续)
        ▼
pi-mono/vendor/pi-mcp-adapter/
```

**修改永远只推到 fork**，fork 是 submodule 的 origin。

#### 场景 1：修改代码

```bash
cd vendor/pi-mcp-adapter
git checkout main
# ... edit ...
git add -A && git commit -m "..."
git push origin main

cd ../..
git add vendor/pi-mcp-adapter
git commit -m "Update pi-mcp-adapter submodule"
```

#### 场景 2：同步上游

```bash
cd vendor/pi-mcp-adapter
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# 检查依赖变更
diff \
  <(node -e "console.log(JSON.stringify(require('./vendor/pi-mcp-adapter/package.json').dependencies, null, 2))") \
  <(node -e "console.log(JSON.stringify(require('./packages/extensions/mcp-adapter/package.json').dependencies, null, 2))")

# 如有新增/升级依赖 → 更新 packages/extensions/mcp-adapter/package.json → npm install

cd ../..
git add vendor/pi-mcp-adapter
git commit -m "Update pi-mcp-adapter submodule (sync upstream)"
```

#### 场景 3：仅查看上游变更

```bash
cd vendor/pi-mcp-adapter
git fetch upstream
git log main..upstream/main --oneline
```

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 忘记 `--recursive` clone | vendor/ 为空，构建失败 | CI 强制 `submodules: recursive`；README 注明 clone 命令 |
| `git checkout main` 忘记执行 | detached HEAD 上 commit 丢失 | 团队文档强调；可在 pre-commit hook 中检查 |
| 修改 vendor/ 后忘记 `git add vendor/` | 其他人拿到旧 submodule SHA | Code review 应能看到 submodule diff |
| 上游新增依赖 | esbuild external 漏掉，运行时 import 失败 | 同步后对比 vendor/package.json；场景 2 已含检查步骤 |
| 上游新增运行时资源文件 | 复制遗漏，运行时读文件失败 | 同步后检查 vendor/ 根目录非 .ts 文件 |
| `@modelcontextprotocol/sdk` 版本不兼容 | 运行时协议错误 | 跟随上游使用相同版本范围 |
| 误 `git push upstream` | 推送到 nicobailon 主仓库 | 确保 upstream remote URL 为 https 只读，或设 `pushurl` 为空 |
| `tsgo` native compiler 不兼容动态 import URL | dev 模式启动失败 | 降级到直接用 vendor 路径（手动加 `// @ts-nocheck`） |

---

## 6. 运行时验证计划

### 6.1 Dev 模式验证

```bash
# 启动 pi dev 模式
./pix.ps1   # 或 ./pix (macOS/Linux)

# 在 TUI 中验证
/mcp          # 应显示 MCP panel 或 status
/mcp setup    # 应打开 setup panel
```

验证点：
- 启动日志无 MCP 相关错误
- `/mcp` 命令已注册且可执行
- 扩展状态栏显示 MCP server 计数

### 6.2 Release bundle 验证

```bash
cd packages/extensions/mcp-adapter
npm run build

# 验证产物
ls packages/coding-agent/extensions/mcp-adapter/
# 预期：index.js, app-bridge.bundle.js, package.json
```

### 6.3 端到端验证

配置一个简单的 MCP server（如 `@modelcontextprotocol/server-filesystem`），验证：
- 连接成功
- 工具列表可查询（`/mcp tools` 或通过 mcp proxy tool）
- 工具调用返回正确结果

---

## 7. 实施步骤

### Phase 1：基础设施（20 分钟）

1. 创建 `packages/extensions/mcp-adapter/` 目录结构
2. 编写 `package.json`（exact versions，对齐 vendor/package.json）
3. 编写 `src/index.ts`（动态 import + URL 构造）
4. 编写 `scripts/build.mjs`（`mkdirSync` 在 `esbuild.build` 之前）
5. 修改 `scripts/check-pinned-deps.mjs`：添加 `"vendor"` 到 `ignoredDirectories`
6. 修改 `scripts/check-ts-relative-imports.mjs`：添加 `"vendor"` 到 `ignoredDirectories`

### Phase 2：Submodule 初始化（15 分钟）

7. 确保 fork (`misutime/pi-mcp-adapter`) 内容与上游同步（或包含所需修改）
8. `git submodule add git@github.com:misutime/pi-mcp-adapter.git vendor/pi-mcp-adapter`
9. `cd vendor/pi-mcp-adapter && git remote add upstream https://github.com/nicobailon/pi-mcp-adapter.git`
10. 提交 `.gitmodules` + submodule 引用

### Phase 3：依赖安装（10 分钟）

11. `npm install --ignore-scripts`

### Phase 4：类型与格式检查（15 分钟）

12. `npm run check` — 确认无类型错误、无 pinned-deps 误报、无 ts-relative-imports 误报

### Phase 5：构建验证（15 分钟）

13. `cd packages/extensions/mcp-adapter && npm run build`
14. 验证 `packages/coding-agent/extensions/mcp-adapter/` 产物：
    - `index.js` 存在且包含完整 bundle
    - `app-bridge.bundle.js` 已复制
    - `package.json` 包含 `pi.extensions`

### Phase 6：运行时验证（30 分钟）

15. 启动 pi dev 模式，验证扩展加载
16. 验证 `/mcp` 命令可用
17. 配置一个 MCP server 做端到端测试

### Phase 7：CI 配置 + 文档（15 分钟）

18. 更新 `.github/workflows/` 中所有 build/check 相关 job 的 checkout 步骤，加 `submodules: recursive`
19. 更新 `DEVELOPMENT.md` 记录 clone 命令和 submodule 工作流
20. 提交

**总计：~2 小时**

---

## 8. 未覆盖项

- pi-mcp-adapter 的 `__tests__/`：位于 vendor/ 内。如果在 monorepo CI 运行需额外配置。**暂不纳入 scope**。
- pi-mcp-adapter 的 `examples/`：不被 bundler 引用。保留在 vendor/ 中作为参考。
- pi-mcp-adapter 的 `pi-mcp.mp4`（~27MB）、`banner.png`：如果 fork 体积是问题，可 `git filter-branch` 清理历史（一次性操作）。
- package-lock.json 变更审核：上游新依赖可能引入 lifecycle scripts。
