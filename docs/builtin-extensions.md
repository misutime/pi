# 内置扩展机制

## 概述

pi 支持两种扩展加载方式：

| 类型 | 加载方式 | 来源 |
|------|---------|------|
| **内置扩展** | 目录扫描 + ESM import | 随 pi 发布，`packages/extensions/` 源码 |
| **用户扩展** | jiti 动态加载 | `.pi/extensions/`、`~/.pi/agent/extensions/`、`-e` 参数 |

本文档说明内置扩展的开发、构建和运行机制。

## 目录结构

```
packages/
├── coding-agent/                    # pi 运行时
│   └── extensions/                  # 内置扩展【构建产物】，gitignore
│       └── webtools/
│           ├── index.js             # esbuild bundle
│           └── package.json         # pi.extensions → ./index.js
│
└── extensions/                      # 内置扩展【源码】
    └── webtools/
        ├── package.json             # 独立 workspace 包，自有依赖
        ├── src/                     # TypeScript 源码
        └── README.md

scripts/
├── build-extension.mjs              # 共享构建脚本（单个扩展）
└── build-all-extensions.mjs         # 批量构建（扫描所有扩展）
```

## Dev 模式 vs Release 模式

### Dev 模式

- 条件：`IS_DEV = true`（运行 `.ts` 源码入口，例如 `pix` / `npx tsx packages/coding-agent/src/cli.ts`）
- 加载源：`packages/extensions/<name>/src/index.ts`（源码，无编译）
- 特点：修改代码 → 重启 pi → 即时生效，无需 `npm run build`

### Release 模式

- 条件：`IS_DEV = false`（运行 `dist/cli.js` 或 npm 安装的 pi）
- 加载源：`packages/coding-agent/extensions/<name>/index.js`（esbuild 产物）
- 特点：第三方依赖已打入 bundle，`@earendil-works/pi-coding-agent` 和 `typebox` 由 host 提供

> **注意**：若本地运行 `dist/cli.js`（而非 tsx 源码入口），即使仍在开发环境中，也会走 release 加载路径，需要先 `npm run build` 生成 bundle。

## 加载流程

```
pi 启动
  → resource-loader.ts
    → loadBuiltinExtensions()
      → 扫描目录：dev → packages/extensions/，release → coding-agent/extensions/
      → IS_DEV ?
        → 是：import(packages/extensions/<name>/src/index.ts)   # tsx 解析 .ts
        → 否：import(coding-agent/extensions/<name>/index.js)   # bundle 产物
      → loadExtensionFromFactory()
```

## 新增内置扩展

无需编辑任何 pi 源码。只需在 `packages/extensions/` 下创建新目录，包含：

### 1. `package.json`

```json
{
  "name": "@pi/新扩展",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node ../../../scripts/build-extension.mjs"
  },
  "dependencies": {
    // 扩展自己的第三方依赖
  }
}
```

必须字段：`name`、`type: "module"`、`scripts.build`。依赖写在 `dependencies` 中（dev 模式直接加载源码时需要它们）。

### 2. `src/index.ts`

需导出默认 factory 函数：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function myExtension(pi: ExtensionAPI): void {
  // 注册工具、事件处理等
}
```

### 3. 完成

无需其他配置。pi 启动时自动扫描目录发现新扩展，`npm run build` 和 `just all` 自动构建所有内置扩展。

## 构建

共享脚本 `scripts/build-extension.mjs` 自动读取当前目录的 `package.json`（`name` 字段作为输出目录名），用 esbuild 将 `src/index.ts` 打包为单文件，外部化 `@earendil-works/pi-coding-agent` 和 `typebox`，其余依赖打入 bundle。

```bash
# 单独构建某个扩展
cd packages/extensions/webtools && npm run build

# 批量构建所有内置扩展
node scripts/build-all-extensions.mjs

# 或构建整个 coding-agent（自动含所有扩展）
cd packages/coding-agent && npm run build
```

构建产物输出到 `packages/coding-agent/extensions/<name>/index.js`（已 gitignore）。

## --no-extensions

`pi --no-extensions`（`pi -ne`）会同时禁用内置扩展和用户扩展，用于故障排查。
